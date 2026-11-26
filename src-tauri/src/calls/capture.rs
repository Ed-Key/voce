//! Bounded capture queues. Audio callbacks never perform disk IO or wait for a lock.
use super::archive::TRACK_LIMIT; // per track, then a visible failure
use super::lifecycle::CapturePermit;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rtrb::{Consumer, Producer, RingBuffer};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, c_void, CStr},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const QUEUE_SAMPLES: usize = 192_000;
/// Samples per loudness reading for the notch's level bars (10 ms at 48 kHz).
const METER_WINDOW: u32 = 480;

/// Recent loudness (RMS) of the live microphone and call-audio tracks, for the notch's
/// level bars. Numbers only: no audio leaves the recorder. Zero when nothing is recording.
pub static MIC_LEVEL: Meter = Meter::new();
pub static SYSTEM_LEVEL: Meter = Meter::new();
/// A reading older than this is silence: the mic was paused or the system tap stopped delivering.
const METER_FRESH_MS: u64 = 200;

pub struct Meter {
    rms: AtomicU32,
    /// Milliseconds since the process clock started, when `rms` was last written.
    at_ms: AtomicU64,
}
impl Meter {
    pub const fn new() -> Self {
        Self {
            rms: AtomicU32::new(0),
            at_ms: AtomicU64::new(0),
        }
    }
    fn clock() -> u64 {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_millis() as u64
            + 1
    }
    fn store(&self, rms: f32) {
        self.rms.store(rms.to_bits(), Ordering::Relaxed);
        self.at_ms.store(Self::clock(), Ordering::Relaxed);
    }
    fn read(&self) -> f32 {
        let fresh =
            Self::clock().saturating_sub(self.at_ms.load(Ordering::Relaxed)) <= METER_FRESH_MS;
        if fresh {
            f32::from_bits(self.rms.load(Ordering::Relaxed))
        } else {
            0.0
        }
    }
}

pub fn live_levels() -> [f32; 2] {
    [MIC_LEVEL.read(), SYSTEM_LEVEL.read()]
}

#[derive(Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct TrackStats {
    pub samples: u64,
    pub peak: f32,
    pub sample_rate: u32,
    pub error: Option<String>,
}

struct Health {
    samples: AtomicU64,
    peak: AtomicU32,
    failed: AtomicBool,
    done: AtomicBool,
    final_frames: AtomicU64,
    meter: Option<&'static Meter>,
}

enum AudioEvent {
    Sample(f32),
    At(u64),
}

pub(super) struct Sink {
    producer: Producer<AudioEvent>,
    health: Arc<Health>,
    permit: Option<Arc<CapturePermit>>,
}
impl Sink {
    fn at(&mut self, offset: u64) {
        if self.health.done.load(Ordering::Acquire) {
            return;
        }
        if self
            .permit
            .as_ref()
            .is_some_and(|permit| !permit.can_record())
        {
            return;
        }
        if self.producer.push(AudioEvent::At(offset)).is_err() {
            self.health.failed.store(true, Ordering::Relaxed);
        }
    }
    pub(super) fn push(&mut self, sample: f32) {
        if self.health.done.load(Ordering::Acquire) {
            return;
        }
        if self
            .permit
            .as_ref()
            .is_some_and(|permit| !permit.can_record())
        {
            return;
        }
        if self.producer.push(AudioEvent::Sample(sample)).is_err() {
            self.health.failed.store(true, Ordering::Relaxed);
        }
    }
}

pub(super) struct Writer {
    health: Arc<Health>,
    task: Option<JoinHandle<Result<(), String>>>,
    rate: u32,
}
impl Writer {
    pub(super) fn new(
        path: &Path,
        rate: u32,
        meter: Option<&'static Meter>,
    ) -> Result<(Self, Sink), String> {
        if !(8000..=192000).contains(&rate) {
            return Err("Unsupported call audio sample rate".into());
        }
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let file = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
        let health = Arc::new(Health {
            samples: AtomicU64::new(0),
            peak: AtomicU32::new(0),
            failed: AtomicBool::new(false),
            done: AtomicBool::new(false),
            final_frames: AtomicU64::new(0),
            meter,
        });
        let (producer, consumer) = RingBuffer::new(QUEUE_SAMPLES);
        let worker_health = health.clone();
        let task = thread::spawn(move || {
            let result = write_audio(file, consumer, worker_health.clone());
            if result.is_err() {
                worker_health.failed.store(true, Ordering::Release);
            }
            result
        });
        Ok((
            Self {
                health: health.clone(),
                task: Some(task),
                rate,
            },
            Sink {
                producer,
                health,
                permit: None,
            },
        ))
    }
    pub(super) fn stats(&self) -> TrackStats {
        TrackStats { samples: self.health.samples.load(Ordering::Relaxed), peak: f32::from_bits(self.health.peak.load(Ordering::Relaxed)), sample_rate: self.rate, error: self.health.failed.load(Ordering::Relaxed).then(|| "Capture interrupted: audio queue, device, disk, or size limit failed. This recording may be incomplete.".into()) }
    }
    pub(super) fn finish(&mut self) -> TrackStats {
        self.health.done.store(true, Ordering::Release);
        let failure = self
            .task
            .take()
            .and_then(|task| task.join().ok())
            .and_then(Result::err);
        let mut stats = self.stats();
        if failure.is_some() {
            stats.error = failure;
        }
        stats
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        self.finish();
    }
}
fn write_audio(
    mut file: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    mut consumer: Consumer<AudioEvent>,
    health: Arc<Health>,
) -> Result<(), String> {
    // The level bars go flat when a track stops, however the writer ends.
    struct Silence(Option<&'static Meter>);
    impl Drop for Silence {
        fn drop(&mut self) {
            if let Some(meter) = self.0 {
                meter.store(0.0);
            }
        }
    }
    let _silence = Silence(health.meter);
    let mut count = 0;
    let (mut energy, mut window) = (0.0f32, 0u32);
    loop {
        let mut read = false;
        while let Ok(event) = consumer.pop() {
            read = true;
            let sample = match event {
                AudioEvent::Sample(sample) => sample,
                AudioEvent::At(target) => {
                    if target.saturating_mul(4) > TRACK_LIMIT {
                        health.failed.store(true, Ordering::Relaxed);
                        return Err("System recording exceeded the track size limit".into());
                    }
                    // A padded gap is silence the tap never delivered; the bars must not freeze on the last sound.
                    if let (Some(meter), true) =
                        (health.meter, target >= count + METER_WINDOW as u64)
                    {
                        meter.store(0.0);
                        (energy, window) = (0.0, 0);
                    }
                    while count < target {
                        file.write_sample(0.0f32).map_err(|e| e.to_string())?;
                        count += 1;
                    }
                    health.samples.store(count, Ordering::Relaxed);
                    continue;
                }
            };
            count += 1;
            if count * 4 > TRACK_LIMIT {
                health.failed.store(true, Ordering::Relaxed);
                return Err(
                    "Recording reached its 1 GiB track limit (about 90 minutes at 48 kHz). Stop this call and start another."
                        .into(),
                );
            }
            file.write_sample(sample).map_err(|e| {
                health.failed.store(true, Ordering::Relaxed);
                e.to_string()
            })?;
            health.samples.store(count, Ordering::Relaxed);
            let peak = f32::from_bits(health.peak.load(Ordering::Relaxed)).max(sample.abs());
            health.peak.store(peak.to_bits(), Ordering::Relaxed);
            if let Some(meter) = health.meter {
                energy += sample * sample;
                window += 1;
                if window == METER_WINDOW {
                    meter.store((energy / window as f32).sqrt());
                    (energy, window) = (0.0, 0);
                }
            }
        }
        if health.done.load(Ordering::Acquire) && !read {
            let target = health.final_frames.load(Ordering::Acquire);
            if target.saturating_mul(4) > TRACK_LIMIT {
                health.failed.store(true, Ordering::Relaxed);
                return Err("System recording exceeded the track size limit".into());
            }
            while count < target {
                file.write_sample(0.0f32).map_err(|e| e.to_string())?;
                count += 1;
            }
            health.samples.store(count, Ordering::Relaxed);
            break;
        }
        // Flush the WAV header as well as samples so a forced quit leaves recoverable audio.
        if count > 0 {
            file.flush().map_err(|e| e.to_string())?;
        }
        thread::sleep(Duration::from_millis(20));
    }
    file.finalize().map_err(|e| e.to_string())
}

pub struct MicTrack {
    stream: Option<cpal::Stream>,
    writer: Writer,
}
pub struct SystemTrack {
    started: std::time::Instant,
    pointer: Option<*mut c_void>,
    _sink: Box<Sink>,
    writer: Writer,
}
// The opaque Core Audio handle has one owner. Moving its Box preserves the
// callback address; stopping quiesces callbacks before the Box is destroyed.
unsafe impl Send for SystemTrack {}
pub fn microphone_authorized() -> bool {
    unsafe { handy_call_microphone_authorized() }
}

impl MicTrack {
    pub fn microphone(path: &Path, permit: Arc<CapturePermit>) -> Result<Self, String> {
        if !microphone_authorized() {
            return Err("Microphone access is missing for Voce. Refresh its Microphone entry in System Settings and reopen the app.".into());
        }
        let device = cpal::default_host()
            .default_input_device()
            .ok_or("No default microphone")?;
        let format = device.default_input_config().map_err(|e| e.to_string())?;
        let (writer, mut sink) = Writer::new(path, format.sample_rate().0, Some(&MIC_LEVEL))?;
        sink.permit = Some(permit);
        let channels = format.channels() as usize;
        let error_health = writer.health.clone();
        let error = move |_e| {
            error_health.failed.store(true, Ordering::Relaxed);
        };
        let config: cpal::StreamConfig = format.clone().into();
        let stream = match format.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    for frame in data.chunks(channels) {
                        sink.push(frame.iter().sum::<f32>() / channels as f32);
                    }
                },
                error,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    for frame in data.chunks(channels) {
                        sink.push(
                            frame.iter().map(|x| *x as f32 / 32768.0).sum::<f32>()
                                / channels as f32,
                        );
                    }
                },
                error,
                None,
            ),
            _ => return Err("Unsupported microphone sample format".into()),
        }
        .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok(Self {
            stream: Some(stream),
            writer,
        })
    }
    pub fn stats(&self) -> TrackStats {
        self.writer.stats()
    }
    pub fn stop(&mut self) -> TrackStats {
        self.writer.health.done.store(true, Ordering::Release);
        self.stream.take();
        self.writer.finish()
    }
}
impl Drop for MicTrack {
    fn drop(&mut self) {
        self.stop();
    }
}
impl SystemTrack {
    pub fn system(path: &Path, permit: Arc<CapturePermit>) -> Result<Self, String> {
        let started = std::time::Instant::now();
        // Core Audio establishes the format before delivering the first callback.
        // The bounded queue buffers that callback until the WAV writer is created.
        let health = Arc::new(Health {
            samples: AtomicU64::new(0),
            peak: AtomicU32::new(0),
            failed: AtomicBool::new(false),
            done: AtomicBool::new(false),
            final_frames: AtomicU64::new(0),
            meter: Some(&SYSTEM_LEVEL),
        });
        let (producer, consumer) = RingBuffer::new(QUEUE_SAMPLES);
        let mut sink = Box::new(Sink {
            producer,
            health: health.clone(),
            permit: Some(permit.clone()),
        });
        let mut rate = 0.0;
        let mut error = [0i8; 512];
        let pointer = unsafe {
            handy_call_tap_start(
                system_sink,
                (&mut *sink as *mut Sink).cast(),
                &mut rate,
                error.as_mut_ptr(),
                error.len() as i32,
            )
        };
        if pointer.is_null() {
            return Err(unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned());
        }
        if permit.cancelled() {
            unsafe { handy_call_tap_stop(pointer) };
            return Err("Call startup was cancelled or timed out".into());
        }
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: rate as u32,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let file = match hound::WavWriter::create(path, spec) {
            Ok(file) => file,
            Err(e) => {
                unsafe { handy_call_tap_stop(pointer) };
                return Err(e.to_string());
            }
        };
        let worker_health = health.clone();
        let task = thread::spawn(move || {
            let result = write_audio(file, consumer, worker_health.clone());
            if result.is_err() {
                worker_health.failed.store(true, Ordering::Release);
            }
            result
        });
        Ok(Self {
            started,
            pointer: Some(pointer),
            _sink: sink,
            writer: Writer {
                health,
                task: Some(task),
                rate: rate as u32,
            },
        })
    }
    pub fn stats(&self) -> TrackStats {
        self.writer.stats()
    }
    pub fn stop(&mut self) -> TrackStats {
        if let Some(pointer) = self.pointer.take() {
            if let Some(permit) = &self._sink.permit {
                permit.cancel();
            }
            self.writer.health.final_frames.store(
                (self.started.elapsed().as_secs_f64() * self.writer.rate as f64) as u64,
                Ordering::Release,
            );
            self.writer.health.done.store(true, Ordering::Release);
            unsafe { handy_call_tap_stop(pointer) };
        }
        self.writer.finish()
    }
}
impl Drop for SystemTrack {
    fn drop(&mut self) {
        self.stop();
    }
}
unsafe extern "C" fn system_sink(data: *const f32, count: u32, offset: u64, context: *mut c_void) {
    if context.is_null() {
        return;
    }
    // Core Audio serializes callbacks for this IOProc. DestroyIOProc quiesces it
    // before Track drops the boxed sink, so the pointer cannot outlive its owner.
    let sink = unsafe { &mut *context.cast::<Sink>() };
    sink.at(offset);
    if data.is_null() {
        return;
    }
    for sample in unsafe { std::slice::from_raw_parts(data, count as usize) } {
        sink.push(*sample);
    }
}
extern "C" {
    fn handy_call_microphone_authorized() -> bool;
    fn handy_call_tap_start(
        sink: unsafe extern "C" fn(*const f32, u32, u64, *mut c_void),
        context: *mut c_void,
        rate: *mut f64,
        error: *mut c_char,
        capacity: i32,
    ) -> *mut c_void;
    fn handy_call_tap_stop(pointer: *mut c_void);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flushes_exact_samples_and_valid_wav_on_stop() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("track.wav");
        let (mut writer, mut sink) = Writer::new(&path, 48000, None).expect("writer");
        for index in 0..4800 {
            sink.push(if index % 2 == 0 { 0.25 } else { -0.5 });
        }
        drop(sink);
        let stats = writer.finish();
        assert_eq!(stats.samples, 4800);
        assert_eq!(stats.peak, 0.5);
        assert!(stats.error.is_none());
        let mut reader = hound::WavReader::open(&path).expect("valid WAV");
        assert_eq!(reader.spec().sample_rate, 48000);
        let samples: Vec<f32> = reader.samples().map(Result::unwrap).collect();
        assert_eq!(samples.len(), 4800);
        assert_eq!(samples[4799], -0.5);
    }
    #[test]
    fn preserves_quiet_periods_between_system_audio_callbacks() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("timed.wav");
        let (mut writer, mut sink) = Writer::new(&path, 48000, None).expect("writer");
        sink.at(48000);
        sink.push(0.5);
        sink.at(96000);
        sink.push(-0.25);
        sink.at(144000);
        drop(sink);
        let stats = writer.finish();
        assert_eq!(stats.samples, 144000);
        let samples: Vec<f32> = hound::WavReader::open(&path)
            .expect("wav")
            .samples()
            .map(Result::unwrap)
            .collect();
        assert_eq!(samples[0], 0.0);
        assert_eq!(samples[48000], 0.5);
        assert_eq!(samples[96000], -0.25);
        assert_eq!(samples[143999], 0.0);
    }
    #[test]
    fn pads_quiet_tail_even_after_the_capture_permit_is_cancelled() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("tail.wav");
        let (mut writer, mut sink) = Writer::new(&path, 48000, None).expect("writer");
        let permit = CapturePermit::new(Duration::from_secs(1));
        permit.commit().unwrap();
        sink.permit = Some(permit.clone());
        sink.push(0.5);
        permit.cancel();
        sink.push(1.0);
        writer.health.final_frames.store(48000, Ordering::Release);
        drop(sink);
        let stats = writer.finish();
        assert_eq!(stats.samples, 48000);
        let samples: Vec<f32> = hound::WavReader::open(&path)
            .unwrap()
            .samples()
            .map(Result::unwrap)
            .collect();
        assert_eq!(samples[0], 0.5);
        assert!(samples[1..].iter().all(|sample| *sample == 0.0));
    }
    #[test]
    fn meter_reports_recent_loudness_and_goes_flat_on_stop() {
        static LEVEL: Meter = Meter::new();
        let wait_for = |want: &dyn Fn(f32) -> bool| {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while !want(LEVEL.read()) && std::time::Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            LEVEL.read()
        };
        let dir = tempfile::tempdir().unwrap();
        let (mut writer, mut sink) =
            Writer::new(&dir.path().join("m.wav"), 48000, Some(&LEVEL)).expect("writer");
        let loud = |sink: &mut Sink| (0..METER_WINDOW).for_each(|_| sink.push(0.5));
        loud(&mut sink);
        assert!((wait_for(&|v| v > 0.0) - 0.5).abs() < 1e-4);
        // No more audio arrives (the tap went quiet or the mic paused): the reading goes stale.
        thread::sleep(Duration::from_millis(METER_FRESH_MS + 50));
        assert_eq!(
            LEVEL.read(),
            0.0,
            "a track that stops delivering reads as silence"
        );
        // A silent gap the system tap never delivered (padded later) also reads as silence.
        loud(&mut sink);
        assert!(wait_for(&|v| v > 0.0) > 0.0);
        sink.at(METER_WINDOW as u64 * 4);
        assert_eq!(
            wait_for(&|v| v == 0.0),
            0.0,
            "a padded gap reads as silence"
        );
        // Loud again, then stop: the stop itself must clear the reading.
        loud(&mut sink);
        assert!(wait_for(&|v| v > 0.0) > 0.0);
        drop(sink);
        writer.finish();
        assert_eq!(LEVEL.read(), 0.0, "a stopped track reads as silence");
    }

    #[test]
    fn bounded_queue_reports_overrun_instead_of_silently_losing_audio() {
        let (producer, _consumer) = RingBuffer::new(2);
        let health = Arc::new(Health {
            samples: AtomicU64::new(0),
            peak: AtomicU32::new(0),
            failed: AtomicBool::new(false),
            done: AtomicBool::new(false),
            final_frames: AtomicU64::new(0),
            meter: None,
        });
        let mut sink = Sink {
            producer,
            health: health.clone(),
            permit: None,
        };
        sink.push(0.1);
        sink.push(0.2);
        sink.push(0.3);
        assert!(health.failed.load(Ordering::Relaxed));
    }
}
