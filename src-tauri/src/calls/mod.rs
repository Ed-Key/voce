//! Explicit, local call sessions. All native handles stay on one capture thread.
pub mod analysis;
mod archive;
pub mod assistie;
mod capture;
mod detection;
pub mod invitation;
mod lifecycle;
pub mod notch;
mod notch_motion;
pub mod plugin;
pub mod responder;
use capture::{MicTrack, SystemTrack, TrackStats};
use detection::{CallApp, CallDetector, DetectionSnapshot};
use lifecycle::{open_bounded, CapturePermit};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MicState {
    #[default]
    Stopped,
    Starting,
    Live,
    Yielded,
    Failed,
}
fn microphone_state(stats: &TrackStats, waiting: Duration) -> MicState {
    if stats.error.is_some() {
        MicState::Failed
    } else if stats.samples > 0 {
        MicState::Live
    } else if waiting >= Duration::from_secs(3) {
        MicState::Failed
    } else {
        MicState::Starting
    }
}

#[derive(Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct CallSession {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub active: bool,
    pub mic_yielded: bool,
    #[serde(default)]
    pub mic_state: MicState,
    #[serde(default)]
    pub mic_gaps: Vec<MicGap>,
    #[serde(default)]
    pub detected_app: Option<CallApp>,
    pub elapsed_ms: u64,
    pub notes: String,
    pub system: TrackStats,
    pub mic_segments: Vec<MicSegment>,
    pub error: Option<String>,
    #[serde(default)]
    pub recovered_at: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct MicGap {
    pub start_ms: u64,
    pub resumed_ms: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct MicSegment {
    pub file: String,
    pub offset_ms: u64,
    pub stats: TrackStats,
}

#[derive(Default)]
struct Ownership {
    dictating: bool,
    call_active: bool,
    permit: Option<Arc<CapturePermit>>,
    generation: u64,
    session_id: Option<String>,
    detected_app: Option<CallApp>,
    mic_state: MicState,
}
impl Ownership {
    fn acquire(&mut self) -> Result<u64, String> {
        if self.dictating {
            return Err("Dictation already owns the microphone".into());
        }
        self.dictating = true;
        self.generation = self.generation.wrapping_add(1);
        Ok(self.generation)
    }
    fn release(&mut self) -> bool {
        std::mem::replace(&mut self.dictating, false)
    }
    fn matches(&self, session_id: &str, generation: u64, dictating: bool) -> bool {
        self.call_active
            && self.session_id.as_deref() == Some(session_id)
            && self.generation == generation
            && self.dictating == dictating
            && self
                .permit
                .as_ref()
                .is_some_and(|permit| !permit.cancelled())
    }
}
struct StartupDirectory {
    path: PathBuf,
    committed: bool,
}
impl Drop for StartupDirectory {
    fn drop(&mut self) {
        if !self.committed {
            if let Err(error) = std::fs::remove_dir_all(&self.path) {
                log::warn!("Clean up aborted call startup: {error}");
            }
        }
    }
}
struct Live {
    session: CallSession,
    started: Instant,
    mic: Option<MicTrack>,
    mic_opened: Option<Instant>,
    system: SystemTrack,
    permit: Arc<CapturePermit>,
    directory: PathBuf,
}
impl Live {
    fn snapshot(&mut self) -> CallSession {
        self.session.elapsed_ms = self.started.elapsed().as_millis() as u64;
        self.session.system = self.system.stats();
        if let (Some(mic), Some(segment)) = (&self.mic, self.session.mic_segments.last_mut()) {
            segment.stats = mic.stats();
            self.session.mic_state = microphone_state(
                &segment.stats,
                self.mic_opened.map(|at| at.elapsed()).unwrap_or_default(),
            );
            if self.session.mic_state == MicState::Live {
                if let Some(gap) = self.session.mic_gaps.last_mut() {
                    if gap.resumed_ms.is_none() {
                        gap.resumed_ms = Some(self.session.elapsed_ms);
                    }
                }
            } else if self.session.mic_state == MicState::Failed && segment.stats.error.is_none() {
                self.session.error = Some("The call microphone opened but delivered no samples within three seconds. Capture was not confirmed.".into());
            }
        }
        self.session.mic_yielded = self.session.mic_state == MicState::Yielded;
        self.session.clone()
    }
    fn save(&mut self) -> Result<(), String> {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let snapshot = self.snapshot();
        let data = serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.directory.join("session.tmp"))
            .map_err(|e| e.to_string())?;
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(
            self.directory.join("session.tmp"),
            self.directory.join("session.json"),
        )
        .map_err(|e| e.to_string())
    }
    fn pause_mic(&mut self) {
        if let Some(mut mic) = self.mic.take() {
            if let Some(segment) = self.session.mic_segments.last_mut() {
                segment.stats = mic.stop();
            }
        }
        self.mic_opened = None;
    }
    fn yield_for_dictation(&mut self) {
        self.pause_mic();
        if self.session.mic_state != MicState::Yielded {
            self.session.mic_gaps.push(MicGap {
                start_ms: self.started.elapsed().as_millis() as u64,
                resumed_ms: None,
            });
        }
        self.session.mic_state = MicState::Yielded;
        self.session.mic_yielded = true;
    }
    fn resume_mic(&mut self) -> Result<(), String> {
        let file = format!("mic-{}.wav", self.session.mic_segments.len());
        let mic = MicTrack::microphone(&self.directory.join(&file), self.permit.clone())?;
        self.session.mic_segments.push(MicSegment {
            file,
            offset_ms: self.started.elapsed().as_millis() as u64,
            stats: mic.stats(),
        });
        self.mic = Some(mic);
        self.mic_opened = Some(Instant::now());
        self.session.mic_state = MicState::Starting;
        self.session.mic_yielded = false;
        Ok(())
    }
}
enum Action {
    Start(Arc<CapturePermit>, Option<CallApp>),
    Stop,
    Snapshot,
    Acquire { session_id: String, generation: u64 },
    Release { session_id: String, generation: u64 },
    Notes { session_id: String, notes: String },
}
struct Request {
    action: Action,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    reply: mpsc::SyncSender<Result<Option<CallSession>, String>>,
}
static NATIVE_START_BUSY: AtomicBool = AtomicBool::new(false);
const START_TIMEOUT: Duration = Duration::from_secs(7);
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(1);

pub struct CallNotesManager {
    sender: mpsc::SyncSender<Request>,
    ownership: Arc<Mutex<Ownership>>,
    unavailable: Option<String>,
    detector: Option<CallDetector>,
}
impl CallNotesManager {
    pub(super) fn active_session_id(&self) -> Option<String> {
        let owner = self.ownership.lock().ok()?;
        (owner.call_active && owner.permit.as_ref().is_some_and(|p| !p.cancelled()))
            .then(|| owner.session_id.clone())
            .flatten()
    }
    pub fn is_active(&self) -> bool {
        self.ownership
            .lock()
            .map_or(true, |owner| owner.call_active)
    }
    pub fn new(app: &AppHandle) -> Self {
        match Self::try_new(app) {
            Ok(manager) => manager,
            Err(error) => {
                log::warn!("Call notes unavailable; dictation remains enabled: {error}");
                Self::disabled(error)
            }
        }
    }
    fn disabled(error: String) -> Self {
        let (sender, _) = mpsc::sync_channel(1);
        Self {
            sender,
            ownership: Arc::new(Mutex::new(Ownership::default())),
            unavailable: Some(error),
            detector: None,
        }
    }
    fn try_new(app: &AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("calls");
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        if std::fs::symlink_metadata(&root)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Call archive must not be a linked directory".into());
        }
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        archive::recover(&root)?;
        let (sender, receiver) = mpsc::sync_channel::<Request>(16);
        let ownership = Arc::new(Mutex::new(Ownership::default()));
        let detector = CallDetector::new(ownership.clone())
            .map_err(|error| {
                log::warn!("Call activity detection unavailable: {error}");
                error
            })
            .ok();
        let worker_ownership = ownership.clone();
        let archive_app = app.clone();
        std::thread::Builder::new().name("call-capture".into()).spawn(move || {
            let ownership = worker_ownership;
            let mut live: Option<Live> = None;
            let mut last = None;
            let mut next_maintenance = Instant::now();
            let mut next_expiry = Instant::now();
            loop {
                // UI traffic must not starve capture-health checks or manifest saves.
                if Instant::now() >= next_maintenance {
                    let recording = live.as_ref().map(|current| current.session.id.clone());
                    maintain_live(&mut live, &mut last, &ownership);
                    // The 90-minute cap and the audio budget end a recording here, not via Stop; it still
                    // needs its post-call transcript and its Terra connection ended.
                    if let Some(saved) = stopped_by_itself(recording.as_deref(), live.is_none(), last.as_ref()) {
                        after_stop(&archive_app, saved);
                    }
                    if live.is_none() && Instant::now() >= next_expiry {
                        if let Some(ai) = archive_app.try_state::<analysis::CallAiManager>() {
                            if let Err(error) = ai.maintain_audio(0) { log::warn!("Call audio retention: {error}"); }
                        }
                        next_expiry = Instant::now() + Duration::from_secs(60);
                    }
                    next_maintenance = Instant::now() + Duration::from_secs(1);
                }
                let request = match receiver.recv_timeout(next_maintenance.saturating_duration_since(Instant::now())) {
                    Ok(request) => request,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                };
                // Stop and resume are cleanup. They must still run if their caller
                // stopped waiting; new work may never run after its deadline.
                let expired = request.cancelled.load(Ordering::Acquire) || Instant::now() >= request.deadline;
                if expired && !matches!(request.action, Action::Stop | Action::Release { .. }) {
                    let _ = request.reply.send(Err("Call request expired before it could run".into()));
                    continue;
                }
                let result = (|| -> Result<Option<CallSession>, String> {
                    match request.action {
                        Action::Start(permit, detected_app) => {
                            if live.is_some() { return Err("A call is already recording".into()); }
                            if ownership.lock().map_err(|e| e.to_string())?.dictating { return Err("Finish dictation before starting a call".into()); }
                            archive_app.try_state::<analysis::CallAiManager>().ok_or("Call archive maintenance is unavailable")?.maintain_audio(archive::CALL_RESERVE)?;
                            if !capture::microphone_authorized() {
                                return Err("Microphone permission is missing for Voce. Refresh its Microphone entry in System Settings and reopen it.".into());
                            }
                            let id = chrono::Utc::now().format("%Y%m%dT%H%M%S%.9f").to_string();
                            let directory = root.join(&id);
                            std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
                            let mut startup_directory = StartupDirectory { path: directory.clone(), committed: false };
                            archive::enroll(&directory)?;
                            let started = Instant::now();
                            let path = directory.join("system.wav");
                            let native_permit = permit.clone();
                            let system = open_bounded(&NATIVE_START_BUSY, permit.clone(), Duration::from_secs(5), move || SystemTrack::system(&path, native_permit))?;
                            let mut next = Live {
                                session: CallSession { id, title: "Call notes".into(), started_at: chrono::Utc::now().to_rfc3339(), active: true, detected_app, ..Default::default() },
                                started, mic: None, mic_opened: None, system, permit: permit.clone(), directory,
                            };
                            // Reserve mic ownership without holding its lock across native IO.
                            {
                                let mut owner = ownership.lock().map_err(|e| e.to_string())?;
                                if owner.dictating || request.cancelled.load(Ordering::Acquire) || permit.cancelled() {
                                    permit.cancel();
                                    return Err("Call start cancelled while waiting for audio. Dictation keeps the microphone.".into());
                                }
                                owner.call_active = true;
                                owner.session_id = Some(next.session.id.clone());
                                owner.detected_app = detected_app;
                                owner.mic_state = MicState::Starting;
                            }
                            let start_result = (|| -> Result<(), String> {
                                next.resume_mic()?;
                                next.save()?;
                                let owner = ownership.lock().map_err(|e| e.to_string())?;
                                if owner.dictating || request.cancelled.load(Ordering::Acquire) {
                                    return Err("Dictation took priority while the call microphone was opening".into());
                                }
                                permit.commit()
                            })();
                            if let Err(error) = start_result {
                                permit.cancel();
                                next.pause_mic();
                                if let Ok(mut owner) = ownership.lock() { owner.call_active = false; }
                                return Err(error);
                            }
                            startup_directory.committed = true;
                            live = Some(next);
                        }
                        Action::Stop => { finish_live(&mut live, &mut last, &ownership); }
                        Action::Acquire { session_id, generation } => {
                            let owner = ownership.lock().map_err(|e| e.to_string())?;
                            // Startup can roll back while this request waits. With no
                            // call handle left, the current dictation may proceed.
                            if live.is_none() && owner.dictating && owner.generation == generation {
                                return Ok(None);
                            }
                            if !owner.matches(&session_id, generation, true) {
                                return Err("Microphone handoff no longer belongs to this call and dictation".into());
                            }
                            drop(owner);
                            if let Some(current) = live.as_mut() {
                                current.yield_for_dictation();
                                if let Err(error) = current.save() { log::error!("Save handoff marker: {error}"); }
                            }
                        }
                        Action::Release { session_id, generation } => {
                            if ownership.lock().map_err(|e| e.to_string())?.matches(&session_id, generation, false) {
                                if let Some(current) = live.as_mut() {
                                    if current.mic.is_none() && !current.permit.cancelled() {
                                        if let Err(error) = current.resume_mic() {
                                            current.session.mic_state = MicState::Failed;
                                            current.session.error = Some(error);
                                        }
                                        if !ownership.lock().map_err(|e| e.to_string())?.matches(&session_id, generation, false) {
                                            current.pause_mic();
                                            current.session.mic_state = MicState::Yielded;
                                        }
                                        current.save()?;
                                    }
                                }
                            }
                        }
                        Action::Notes { session_id, notes } => {
                            if notes.len() > 256 * 1024 { return Err("Notes exceed 256 KiB".into()); }
                            let current = live.as_mut().ok_or("Start a call before saving notes")?;
                            if current.session.id != session_id { return Err("These notes belong to a different call".into()); }
                            current.session.notes = notes;
                            current.save()?;
                        }
                        Action::Snapshot => {}
                    }
                    Ok(live.as_mut().map(Live::snapshot).or_else(|| last.clone()))
                })();
                publish_ownership(&mut live, &ownership);
                let _ = request.reply.send(result);
            }
            finish_live(&mut live, &mut last, &ownership);
        }).map_err(|e| e.to_string())?;
        Ok(Self {
            sender,
            ownership,
            unavailable: None,
            detector,
        })
    }
    fn request(&self, action: Action) -> Result<Option<CallSession>, String> {
        if let Some(error) = &self.unavailable {
            return Err(format!("Call notes are unavailable: {error}"));
        }
        let timeout = match action {
            Action::Start(..) => START_TIMEOUT,
            Action::Acquire { .. } | Action::Release { .. } => HANDOFF_TIMEOUT,
            _ => Duration::from_secs(2),
        };
        let (reply, response) = mpsc::sync_channel(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        self.sender
            .try_send(Request {
                action,
                deadline: Instant::now() + timeout,
                cancelled: cancelled.clone(),
                reply,
            })
            .map_err(|e| format!("Call recorder is unavailable: {e}"))?;
        response.recv_timeout(timeout).map_err(|error| { cancelled.store(true, Ordering::Release); format!("Call recorder did not respond: {error}. Reopen Voce if macOS is waiting for a permission.") })?
    }
    fn start(&self) -> Result<Option<CallSession>, String> {
        let permit = CapturePermit::new(START_TIMEOUT);
        {
            let mut owner = self.ownership.lock().map_err(|e| e.to_string())?;
            if owner.dictating {
                return Err("Finish dictation before starting a call".into());
            }
            if owner.call_active || owner.permit.as_ref().is_some_and(|p| !p.cancelled()) {
                return Err("A call is already starting or recording".into());
            }
            owner.permit = Some(permit.clone());
        }
        let detected_app = self.detector.as_ref().and_then(CallDetector::candidate);
        let result = self.request(Action::Start(permit.clone(), detected_app));
        if result.is_err() {
            permit.cancel();
        }
        result
    }
    fn stop_session(&self) -> Result<Option<CallSession>, String> {
        if let Ok(owner) = self.ownership.lock() {
            if let Some(permit) = &owner.permit {
                permit.cancel();
            }
        }
        self.request(Action::Stop)
    }
    pub fn acquire_dictation(&self) -> Result<(), String> {
        let scope = {
            let mut owner = self.ownership.lock().map_err(|e| e.to_string())?;
            let generation = owner.acquire()?;
            owner
                .call_active
                .then(|| owner.session_id.clone().map(|id| (id, generation)))
                .flatten()
        };
        // A native permission dialog must never delay ordinary dictation.
        let Some((session_id, generation)) = scope else {
            return Ok(());
        };
        if let Err(error) = self.request(Action::Acquire {
            session_id,
            generation,
        }) {
            self.release_dictation();
            return Err(error);
        }
        Ok(())
    }
    pub fn release_dictation(&self) {
        let scope = match self.ownership.lock() {
            Ok(mut owner) => {
                if owner.release() && owner.call_active {
                    owner.session_id.clone().map(|id| (id, owner.generation))
                } else {
                    None
                }
            }
            Err(error) => {
                log::error!("Call ownership failed: {error}");
                return;
            }
        };
        if let Some((session_id, generation)) = scope {
            if let Err(error) = self.request(Action::Release {
                session_id,
                generation,
            }) {
                log::error!("Call microphone resume failed: {error}");
            }
        }
    }
    pub fn stop(&self) {
        let _ = self.stop_session();
    }
    fn detection_snapshot(&self) -> DetectionSnapshot {
        self.detector
            .as_ref()
            .map(CallDetector::snapshot)
            .unwrap_or_default()
    }
}
fn publish_ownership(live: &mut Option<Live>, ownership: &Mutex<Ownership>) {
    let snapshot = live.as_mut().map(Live::snapshot);
    if let Ok(mut owner) = ownership.lock() {
        owner.call_active = snapshot.is_some();
        owner.session_id = snapshot.as_ref().map(|session| session.id.clone());
        owner.detected_app = snapshot.as_ref().and_then(|session| session.detected_app);
        owner.mic_state = snapshot
            .map(|session| session.mic_state)
            .unwrap_or_default();
    }
}
fn maintain_live(
    live: &mut Option<Live>,
    last: &mut Option<CallSession>,
    ownership: &Mutex<Ownership>,
) {
    if let Some(current) = live.as_mut() {
        let snapshot = current.snapshot();
        let failed = snapshot.mic_state == MicState::Failed
            || snapshot.system.error.is_some()
            || snapshot
                .mic_segments
                .iter()
                .any(|segment| segment.stats.error.is_some());
        let audio_bytes = snapshot
            .system
            .samples
            .saturating_add(
                snapshot
                    .mic_segments
                    .iter()
                    .map(|s| s.stats.samples)
                    .sum::<u64>(),
            )
            .saturating_mul(4);
        if audio_bytes >= archive::CALL_RESERVE - archive::STOP_MARGIN {
            current.session.error = Some("Recording stopped at the per-call audio budget. Saved audio and notes are retained.".into());
            current.permit.cancel();
        }
        if current.permit.cancelled()
            || current.started.elapsed().as_secs() >= archive::MAX_CALL_SECONDS
            || failed
        {
            current.session.error.get_or_insert_with(|| "Recording stopped after cancellation, capture failure, or the 90 minute development limit.".into());
            finish_live(live, last, ownership);
        } else if let Err(error) = current.save() {
            current.session.error = Some(error);
            finish_live(live, last, ownership);
        }
    }
    publish_ownership(live, ownership);
}
fn finish_live(
    live: &mut Option<Live>,
    last: &mut Option<CallSession>,
    ownership: &Mutex<Ownership>,
) {
    if let Some(mut current) = live.take() {
        current.permit.cancel();
        current.pause_mic();
        if let Ok(mut owner) = ownership.lock() {
            owner.call_active = false;
            owner.session_id = None;
            owner.detected_app = None;
            owner.mic_state = MicState::Stopped;
        }
        current.session.active = false;
        current.session.mic_state = MicState::Stopped;
        current.session.mic_yielded = false;
        current.session.system = current.system.stop();
        if let Err(error) = current.save() {
            log::error!("Save stopped call: {error}");
            current.session.error = Some(format!("Capture stopped, but the final notes/manifest could not be saved: {error}. Keep a copy of unsaved notes. Saved audio will be checked for recovery at the next launch."));
        }
        *last = Some(current.session.clone());
    }
}

#[tauri::command]
#[specta::specta]
pub fn call_detection_snapshot(app: AppHandle) -> DetectionSnapshot {
    app.state::<CallNotesManager>().detection_snapshot()
}

#[tauri::command]
#[specta::specta]
pub async fn start_call_notes(app: AppHandle) -> Result<Option<CallSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = crate::settings::get_settings(&app);
        if settings.always_on_microphone || settings.lazy_stream_close || settings.mute_while_recording {
            return Err("Call capture requires on-demand microphone, immediate stream close, and Mute While Recording turned off.".into());
        }
        if let Some(ai) = app.try_state::<analysis::CallAiManager>() { ai.interrupt(); }
        let session = app.state::<CallNotesManager>().start()?;
        if let (Some(ai), Some(started)) = (app.try_state::<analysis::CallAiManager>(), session.as_ref()) {
            if let Err(error) = ai.follow(&started.id) { log::warn!("Local live transcript unavailable: {error}"); }
        }
        Ok(session)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
#[specta::specta]
pub async fn stop_call_notes(app: AppHandle) -> Result<Option<CallSession>, String> {
    let call_id = app.state::<CallNotesManager>().active_session_id();
    let capture_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let app = capture_app;
        let stopped = app.state::<CallNotesManager>().stop_session();
        match (
            &stopped,
            stop_cleanup(
                call_id.as_deref(),
                stopped.as_ref().ok().and_then(Option::as_ref),
            ),
        ) {
            (Ok(Some(saved)), StopCleanup::AfterStop) => after_stop(&app, saved),
            (_, StopCleanup::RevokeOnly(id)) => {
                // Stop failed or returned another call: still revoke this call's consent.
                let (app, id) = (app.clone(), id.to_string());
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = assistie::stop_for_call(&app, id).await {
                        log::warn!("End stopped call's Assistie connection: {error}");
                    }
                });
            }
            _ => {}
        }
        stopped
    })
    .await
    .map_err(|e| e.to_string())?;
    result
}

#[derive(Debug, PartialEq)]
enum StopCleanup<'a> {
    /// This Stop ended the recording: queue its transcript and end its Terra connection.
    AfterStop,
    /// A call was live but Stop failed or returned another session: only revoke that call's consent.
    RevokeOnly(&'a str),
    /// Nothing was recording (a repeated Stop): nothing to do, and never requeue the earlier call.
    Nothing,
}

fn stop_cleanup<'a>(live: Option<&'a str>, stopped: Option<&CallSession>) -> StopCleanup<'a> {
    match (live, stopped) {
        (Some(id), Some(saved)) if saved.id == id => StopCleanup::AfterStop,
        (Some(id), _) => StopCleanup::RevokeOnly(id),
        (None, _) => StopCleanup::Nothing,
    }
}

/// The recording that maintenance just ended by itself, if any: it was live before, nothing is live now,
/// and the last saved session is that same call.
fn stopped_by_itself<'a>(
    recording: Option<&str>,
    now_idle: bool,
    last: Option<&'a CallSession>,
) -> Option<&'a CallSession> {
    last.filter(|saved| now_idle && recording == Some(saved.id.as_str()))
}

/// True the first time a call id is seen; later Stop/auto-stop paths for the same call do nothing.
fn first_after_stop(id: &str) -> bool {
    static DONE: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    DONE.get_or_init(Default::default)
        .lock()
        .map(|mut done| done.insert(id.to_string()))
        .unwrap_or(true)
}

/// Calls shorter than this are tests or false starts: not worth a summary run.
const SUMMARY_MIN_MS: u64 = 60_000;
fn should_transcribe(saved: &CallSession) -> bool {
    !saved.active && saved.elapsed_ms > SUMMARY_MIN_MS
}

/// After a recording ends, by Stop or by itself: queue its local transcript and end its Terra connection.
/// Capture has already closed; bridge cleanup runs off this thread, and only the matching call's consent is
/// revoked.
fn after_stop(app: &AppHandle, saved: &CallSession) {
    // Stop and an automatic stop can both see the same call end (Stop cancels the permit, maintenance can
    // finish the call before the Stop request runs); the effects belong to the call, so they run once.
    if !first_after_stop(&saved.id) {
        return;
    }
    if should_transcribe(saved) {
        if let Some(ai) = app.try_state::<analysis::CallAiManager>() {
            if let Err(error) = ai.enqueue(&saved.id) {
                log::warn!("Queue stopped call: {error}");
            }
        }
    }
    let (app, id) = (app.clone(), saved.id.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(error) = assistie::stop_for_call(&app, id).await {
            log::warn!("End stopped call's Assistie connection: {error}");
        }
    });
}
#[tauri::command]
#[specta::specta]
pub async fn call_notes_snapshot(app: AppHandle) -> Result<Option<CallSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<CallNotesManager>().request(Action::Snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
#[specta::specta]
pub async fn save_call_notes(
    app: AppHandle,
    session_id: String,
    notes: String,
) -> Result<Option<CallSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<CallNotesManager>()
            .request(Action::Notes { session_id, notes })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn microphone_requires_samples_including_silence_before_reporting_live() {
        let mut stats = TrackStats::default();
        assert_eq!(microphone_state(&stats, Duration::ZERO), MicState::Starting);
        assert_eq!(
            microphone_state(&stats, Duration::from_secs(3)),
            MicState::Failed
        );
        stats.samples = 480;
        assert_eq!(stats.peak, 0.0);
        assert_eq!(
            microphone_state(&stats, Duration::from_secs(3)),
            MicState::Live
        );
        stats.error = Some("Device disconnected".into());
        assert_eq!(microphone_state(&stats, Duration::ZERO), MicState::Failed);
    }
    #[test]
    fn delayed_handoff_cannot_touch_new_dictation_or_replacement_call() {
        let permit = CapturePermit::new(START_TIMEOUT);
        permit.commit().unwrap();
        let mut owner = Ownership {
            call_active: true,
            session_id: Some("first".into()),
            permit: Some(permit.clone()),
            ..Default::default()
        };
        let first = owner.acquire().unwrap();
        assert!(owner.matches("first", first, true));
        owner.release();
        assert!(!owner.matches("first", first, true));
        assert!(owner.matches("first", first, false));
        let second = owner.acquire().unwrap();
        assert!(!owner.matches("first", first, false));
        assert!(!owner.matches("first", first, true));
        owner.release();
        owner.session_id = Some("replacement".into());
        assert!(!owner.matches("first", second, false));
        assert!(owner.matches("replacement", second, false));
        permit.cancel();
        assert!(!owner.matches("replacement", second, false));
    }
    fn saved(id: &str, active: bool, elapsed_ms: u64) -> CallSession {
        CallSession {
            id: id.into(),
            active,
            elapsed_ms,
            ..Default::default()
        }
    }

    #[test]
    fn a_recording_that_stops_by_itself_is_detected_once() {
        let call = saved("call-a", false, 5_400_000);
        // The 90-minute cap or audio budget ended the live call during maintenance.
        assert_eq!(
            stopped_by_itself(Some("call-a"), true, Some(&call)).map(|s| s.id.as_str()),
            Some("call-a")
        );
        // Still recording, or nothing was recording: nothing to do.
        assert!(stopped_by_itself(Some("call-a"), false, Some(&call)).is_none());
        assert!(stopped_by_itself(None, true, Some(&call)).is_none());
        // Stop already ended it earlier (last is that call, but nothing was live this tick): no requeue.
        assert!(stopped_by_itself(None, true, Some(&call)).is_none());
        // A different call is the last saved one (stop then an immediate new call): not this one.
        assert!(stopped_by_itself(Some("call-b"), true, Some(&call)).is_none());
    }

    #[test]
    fn after_stop_effects_run_once_per_call() {
        assert!(
            first_after_stop("race-call"),
            "the first path to see the call end runs the effects"
        );
        assert!(
            !first_after_stop("race-call"),
            "the other path (Stop vs maintenance) does nothing"
        );
        assert!(
            first_after_stop("next-call"),
            "an immediate new call still gets its own"
        );
    }

    #[test]
    fn stop_cleans_up_only_the_call_it_ended() {
        let call = saved("call-a", false, 600_000);
        assert_eq!(
            stop_cleanup(Some("call-a"), Some(&call)),
            StopCleanup::AfterStop
        );
        // Stop failed (recorder request timed out): no session, but this call's consent is still revoked.
        assert_eq!(
            stop_cleanup(Some("call-a"), None),
            StopCleanup::RevokeOnly("call-a")
        );
        // Stop returned a different (earlier) session: revoke the live call, do not queue the other one.
        assert_eq!(
            stop_cleanup(Some("call-b"), Some(&call)),
            StopCleanup::RevokeOnly("call-b")
        );
        // Repeated Stop, or Stop after an automatic stop: nothing live, nothing requeued.
        assert_eq!(stop_cleanup(None, Some(&call)), StopCleanup::Nothing);
    }

    #[test]
    fn only_finished_calls_over_five_minutes_get_a_transcript() {
        assert!(should_transcribe(&saved("long", false, 5_400_000)));
        assert!(should_transcribe(&saved("minutes", false, 120_000)));
        assert!(!should_transcribe(&saved("short", false, 59_000)));
        assert!(!should_transcribe(&saved("unsaved", true, 5_400_000)));
    }

    #[test]
    fn old_manifests_remain_readable_and_app_names_match_frontend() {
        let mut value = serde_json::to_value(CallSession::default()).unwrap();
        for key in ["mic_state", "mic_gaps", "detected_app"] {
            value.as_object_mut().unwrap().remove(key);
        }
        let old: CallSession = serde_json::from_value(value).unwrap();
        assert!(old.mic_gaps.is_empty());
        assert_eq!(old.mic_state, MicState::Stopped);
        assert_eq!(
            serde_json::to_string(&CallApp::FaceTime).unwrap(),
            "\"face_time\""
        );
    }
    #[test]
    fn handoff_rejects_duplicate_acquire_and_stale_resume() {
        let mut owner = Ownership::default();
        assert!(!owner.release());
        assert!(owner.acquire().is_ok());
        assert!(owner.acquire().is_err());
        assert!(owner.release());
        assert!(!owner.release());
        assert!(owner.acquire().is_ok());
    }
    #[test]
    fn dictation_does_not_wait_for_a_pending_native_start() {
        let (sender, receiver) = mpsc::sync_channel(16);
        let manager = CallNotesManager {
            sender,
            unavailable: None,
            detector: None,
            ownership: Arc::new(Mutex::new(Ownership {
                permit: Some(CapturePermit::new(START_TIMEOUT)),
                ..Default::default()
            })),
        };
        manager.acquire_dictation().unwrap();
        assert!(manager.ownership.lock().unwrap().dictating);
        manager.release_dictation();
        assert!(!manager.ownership.lock().unwrap().dictating);
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }
    #[test]
    fn stale_release_never_resumes_a_stopped_call() {
        let (sender, receiver) = mpsc::sync_channel(16);
        let manager = CallNotesManager {
            sender,
            unavailable: None,
            detector: None,
            ownership: Arc::new(Mutex::new(Ownership {
                dictating: true,
                ..Default::default()
            })),
        };
        manager.release_dictation();
        manager.release_dictation();
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }
    #[test]
    fn archive_initialization_failure_leaves_dictation_available() {
        let manager = CallNotesManager::disabled("Archive permission denied".into());
        manager.acquire_dictation().unwrap();
        manager.release_dictation();
        assert!(
            matches!(manager.start(), Err(error) if error.contains("Archive permission denied"))
        );
    }
    #[test]
    fn stop_disables_callbacks_before_waiting_for_native_cleanup() {
        let permit = CapturePermit::new(START_TIMEOUT);
        permit.commit().unwrap();
        let (sender, receiver) = mpsc::sync_channel(16);
        let manager = CallNotesManager {
            sender,
            unavailable: None,
            detector: None,
            ownership: Arc::new(Mutex::new(Ownership {
                call_active: true,
                permit: Some(permit.clone()),
                ..Default::default()
            })),
        };
        let task = std::thread::spawn(move || manager.stop_session());
        let request = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(!permit.can_record());
        assert!(matches!(request.action, Action::Stop));
        request.reply.send(Ok(None)).unwrap();
        assert!(task.join().unwrap().is_ok());
    }
    #[test]
    fn failed_start_does_not_fill_the_archive_with_empty_sessions() {
        let root = tempfile::tempdir().unwrap();
        let failed = root.path().join("failed");
        std::fs::create_dir(&failed).unwrap();
        std::fs::write(failed.join("pending.wav"), []).unwrap();
        drop(StartupDirectory {
            path: failed.clone(),
            committed: false,
        });
        assert!(!failed.exists());
        let saved = root.path().join("saved");
        std::fs::create_dir(&saved).unwrap();
        drop(StartupDirectory {
            path: saved.clone(),
            committed: true,
        });
        assert!(saved.exists());
    }
}
