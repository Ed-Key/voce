//! Recovery and audio-only expiry. Call audio expires LIFETIME after its
//! transcript completes; unmarked recordings and calls without a complete,
//! error-free transcript keep their audio.
use super::{analysis, capture::TrackStats, CallSession, MicSegment, MicState};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

// A call may record MAX_CALL_SECONDS: at 48 kHz float mono a track is about 0.97 GiB for 90 minutes, so a
// track may reach 1 GiB, a call (system + microphone) reserves 2 GiB, and the store keeps up to 6 GiB.
pub const MAX_CALL_SECONDS: u64 = 90 * 60;
pub const TRACK_LIMIT: u64 = 1024 * 1024 * 1024;
pub const AUDIO_BUDGET: u64 = 6 * 1024 * 1024 * 1024;
pub const CALL_RESERVE: u64 = 2 * 1024 * 1024 * 1024;
pub const STOP_MARGIN: u64 = 8 * 1024 * 1024;
/// Call audio is kept 3 days (transcripts, notes, summaries stay).
const LIFETIME: u64 = 3 * 24 * 3600;

#[derive(Default, Serialize, Deserialize)]
struct Retention {
    version: u32,
    completed_at: Option<u64>,
    deletion_started_at: Option<u64>,
    deleted_at: Option<u64>,
}
#[derive(Default, Serialize, specta::Type)]
pub struct AudioStatus {
    pub managed: bool,
    pub expires_at: Option<u64>,
    pub expired: bool,
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn enroll(path: &Path) -> Result<(), String> {
    analysis::write(
        &path.join("retention.json"),
        &Retention {
            version: 1,
            ..Default::default()
        },
    )
}
pub fn status(path: &Path) -> Result<AudioStatus, String> {
    if !path.join("retention.json").exists() {
        return Ok(AudioStatus::default());
    }
    let r: Retention = analysis::read(&path.join("retention.json"))?;
    if r.version != 1 {
        return Err("Unsupported call audio retention policy".into());
    }
    Ok(AudioStatus {
        managed: true,
        expires_at: r.completed_at.map(|t| t.saturating_add(LIFETIME)),
        expired: r.deletion_started_at.is_some(),
    })
}
fn is_track(name: &str) -> bool {
    name == "system.wav"
        || name
            .strip_prefix("mic-")
            .and_then(|s| s.strip_suffix(".wav"))
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}
fn tracks(path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut result = Vec::new();
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if is_track(&entry.file_name().to_string_lossy()) {
            let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            use std::os::unix::fs::MetadataExt;
            if !meta.is_file() || meta.nlink() != 1 {
                return Err("Call audio must be an unlinked regular file".into());
            }
            result.push(entry.path());
        }
    }
    result.sort_by_key(|p| {
        p.file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("mic-"))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(u64::MAX)
    });
    Ok(result)
}
fn usage(path: &Path, depth: usize) -> Result<u64, String> {
    if depth > 8 {
        return Err("Call archive is nested too deeply".into());
    }
    let mut bytes = 0u64;
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("Call archive contains a linked file; review it before recording".into());
        }
        if meta.is_dir() {
            bytes = bytes.saturating_add(usage(&entry.path(), depth + 1)?);
        } else if entry.path().extension().is_some_and(|e| e == "wav") {
            bytes = bytes.saturating_add(meta.len());
        }
    }
    Ok(bytes)
}

/// Caller holds the AI queue lock, so enqueue/cancel cannot race audio expiry.
pub fn maintain(root: &Path, protected: &[String], reserve: u64, time: u64) -> Result<(), String> {
    let mut total = usage(root, 0)?;
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if protected.contains(&id) {
            continue;
        }
        let path = analysis::folder(root, &id)?;
        if !path.join("retention.json").exists() {
            continue;
        }
        let mut retention: Retention = analysis::read(&path.join("retention.json"))?;
        if retention.version != 1 {
            continue;
        }
        let session: CallSession = analysis::read(&path.join("session.json"))?;
        if session.active {
            continue;
        }
        let audio = tracks(&path)?;
        if audio.is_empty() {
            continue;
        }
        let transcript = analysis::read::<analysis::Transcript>(&path.join("transcript.json")).ok();
        // Failed/incomplete/stale transcripts never authorize deletion.
        if !transcript
            .is_some_and(|t| t.complete && t.recording_key == analysis::recording_key(&session))
            || session.system.error.is_some()
            || session.mic_segments.iter().any(|s| s.stats.error.is_some())
        {
            continue;
        }
        let completed = match retention.completed_at {
            Some(t) => t,
            None => {
                let modified = fs::metadata(path.join("transcript.json"))
                    .and_then(|m| m.modified())
                    .map_err(|e| e.to_string())?
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_secs()
                    .min(time);
                retention.completed_at = Some(modified);
                analysis::write(&path.join("retention.json"), &retention)?;
                modified
            }
        };
        candidates.push((completed, path, retention, audio));
    }
    candidates.sort_by_key(|c| c.0);
    for (completed, path, mut retention, audio) in candidates {
        if retention.deletion_started_at.is_none()
            && time.saturating_sub(completed) < LIFETIME
            && total.saturating_add(reserve) <= AUDIO_BUDGET
        {
            continue;
        }
        retention.deletion_started_at.get_or_insert(time);
        // Durable intent makes a partial unlink retryable without deleting text.
        analysis::write(&path.join("retention.json"), &retention)?;
        for file in audio {
            let len = fs::symlink_metadata(&file)
                .map_err(|e| e.to_string())?
                .len();
            fs::remove_file(file).map_err(|e| e.to_string())?;
            total = total.saturating_sub(len);
        }
        retention.deleted_at = Some(time);
        analysis::write(&path.join("retention.json"), &retention)?;
    }
    if total.saturating_add(reserve) > AUDIO_BUDGET {
        return Err("The 6 GiB call-audio budget has no safe space for another recording. Existing calls and incomplete jobs are protected; review their audio before recording again.".into());
    }
    Ok(())
}

// Only our mono float32 WAVs are repaired; headers are updated without discarding payload.
fn recover_wav(path: &Path) -> Result<TrackStats, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.nlink() != 1 || meta.len() > TRACK_LIMIT + 1024 {
        return Err("Unsafe or oversized recovered audio".into());
    }
    let mut head = [0u8; 12];
    file.read_exact(&mut head).map_err(|e| e.to_string())?;
    if &head[..4] != b"RIFF" || &head[8..] != b"WAVE" {
        return Err("Recovered audio is not a WAV".into());
    }
    let mut offset = 12u64;
    let mut format = None;
    while offset + 8 <= meta.len() && offset < 65536 {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut chunk = [0u8; 8];
        file.read_exact(&mut chunk).map_err(|e| e.to_string())?;
        let size = u32::from_le_bytes(chunk[4..8].try_into().unwrap()) as u64;
        if &chunk[..4] == b"fmt " {
            if !(16..=64).contains(&size) {
                return Err("Unsupported recovered WAV format".into());
            }
            let mut fmt = vec![0; size as usize];
            file.read_exact(&mut fmt).map_err(|e| e.to_string())?;
            let code = u16::from_le_bytes(fmt[0..2].try_into().unwrap());
            let channels = u16::from_le_bytes(fmt[2..4].try_into().unwrap());
            let rate = u32::from_le_bytes(fmt[4..8].try_into().unwrap());
            let block = u16::from_le_bytes(fmt[12..14].try_into().unwrap());
            let bits = u16::from_le_bytes(fmt[14..16].try_into().unwrap());
            let float = code == 3
                || (code == 65534
                    && fmt.len() == 40
                    && fmt[24..40] == [3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]);
            if !float
                || channels != 1
                || bits != 32
                || block != 4
                || !(8000..=192000).contains(&rate)
            {
                return Err("Unsupported recovered WAV format".into());
            }
            format = Some(rate);
        } else if &chunk[..4] == b"data" {
            let rate = format.ok_or("Recovered WAV lacks format")?;
            let bytes = (meta.len() - offset - 8) / 4 * 4;
            file.seek(SeekFrom::Start(offset + 4))
                .map_err(|e| e.to_string())?;
            file.write_all(&(bytes as u32).to_le_bytes())
                .map_err(|e| e.to_string())?;
            file.seek(SeekFrom::Start(4)).map_err(|e| e.to_string())?;
            file.write_all(&((offset + bytes) as u32).to_le_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            return Ok(TrackStats {
                samples: bytes / 4,
                sample_rate: rate,
                ..Default::default()
            });
        }
        offset = offset
            .checked_add(8 + size + size % 2)
            .ok_or("Invalid recovered WAV chunks")?;
    }
    Err("Recovered WAV lacks audio data".into())
}

pub fn recover(root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let path = analysis::folder(root, &id)?;
        let primary = path.join("session.json");
        let temporary = path.join("session.tmp");
        let original = analysis::read::<CallSession>(&primary)
            .ok()
            .filter(|s| s.id == id);
        if analysis::read::<CallSession>(&primary).is_ok_and(|s| s.id != id) {
            return Err("Call manifest identity does not match its folder".into());
        }
        let pending = analysis::read::<CallSession>(&temporary)
            .ok()
            .filter(|s| s.id == id);
        let newer = temporary.metadata().and_then(|m| m.modified()).ok()
            > primary.metadata().and_then(|m| m.modified()).ok();
        let original_active = original.as_ref().is_some_and(|s| s.active);
        let mut session = if newer {
            pending.or(original)
        } else {
            original.or(pending)
        };
        if session.as_ref().is_some_and(|s| !s.active) && !original_active && !newer {
            continue;
        }
        let audio = tracks(&path)?;
        if session.is_none() && audio.is_empty() {
            continue;
        }
        if primary.exists() && analysis::read::<CallSession>(&primary).is_err() {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
            let mut source = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&primary)
                .map_err(|e| e.to_string())?;
            let meta = source.metadata().map_err(|e| e.to_string())?;
            if !meta.is_file() || meta.nlink() != 1 || meta.len() > 4 * 1024 * 1024 {
                return Err("Unsafe interrupted session manifest".into());
            }
            let backup = path.join("session.damaged.json");
            if fs::symlink_metadata(&backup).is_err() {
                let mut target = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(backup)
                    .map_err(|e| e.to_string())?;
                std::io::copy(&mut source, &mut target).map_err(|e| e.to_string())?;
                target.sync_all().map_err(|e| e.to_string())?;
            }
        }
        let mut value = session.take().unwrap_or_else(|| CallSession {
            id: id.clone(),
            title: "Recovered recording".into(),
            started_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        });
        for file in audio {
            let name = file.file_name().unwrap().to_string_lossy().into_owned();
            let stats = recover_wav(&file).unwrap_or_else(|e| TrackStats {
                error: Some(e),
                ..Default::default()
            });
            if name == "system.wav" {
                value.system = stats;
            } else if let Some(segment) = value.mic_segments.iter_mut().find(|s| s.file == name) {
                segment.stats = stats;
            } else {
                let offset_ms = value
                    .mic_segments
                    .iter()
                    .map(|s| s.offset_ms.saturating_add(duration(&s.stats)))
                    .max()
                    .unwrap_or_default();
                value.mic_segments.push(MicSegment {
                    file: name,
                    offset_ms,
                    stats,
                });
            }
        }
        if !path.join("system.wav").exists() {
            value.system.error = Some("System audio was missing after interruption".into());
        }
        for segment in &mut value.mic_segments {
            if !is_track(&segment.file) || !path.join(&segment.file).is_file() {
                segment.stats.error =
                    Some("Microphone audio was missing after interruption".into());
            }
        }
        value.elapsed_ms = value.elapsed_ms.max(duration(&value.system)).max(
            value
                .mic_segments
                .iter()
                .map(|s| s.offset_ms.saturating_add(duration(&s.stats)))
                .max()
                .unwrap_or_default(),
        );
        for gap in &mut value.mic_gaps {
            if gap.resumed_ms.is_none() {
                gap.resumed_ms = Some(value.elapsed_ms);
            }
        }
        value.active = false;
        value.mic_state = MicState::Stopped;
        value.mic_yielded = false;
        value.recovered_at = Some(chrono::Utc::now().to_rfc3339());
        let previous = value.error.take().unwrap_or_default();
        value.error = Some(format!("Recovered after interruption. Audio and timing may be incomplete; review before relying on notes. {previous}"));
        analysis::write(&primary, &value)?;
    }
    Ok(())
}
fn duration(stats: &TrackStats) -> u64 {
    stats
        .samples
        .saturating_mul(1000)
        .checked_div(stats.sample_rate as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wav(path: &Path, count: usize) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for _ in 0..count {
            writer.write_sample(0.1f32).unwrap();
        }
        writer.finalize().unwrap();
    }
    fn session(root: &Path, id: &str, managed: bool, complete: bool) -> PathBuf {
        let p = root.join(id);
        fs::create_dir(&p).unwrap();
        wav(&p.join("system.wav"), 160);
        let session = CallSession {
            id: id.into(),
            notes: "Keep my notes".into(),
            ..Default::default()
        };
        analysis::write(&p.join("session.json"), &session).unwrap();
        if managed {
            enroll(&p).unwrap();
        }
        if complete {
            analysis::write(
                &p.join("transcript.json"),
                &analysis::Transcript {
                    complete: true,
                    recording_key: analysis::recording_key(&session),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        fs::write(p.join("summary.json"), b"Keep edited summary").unwrap();
        p
    }
    #[test]
    fn crash_repairs_stale_headers_and_closes_session_without_capture() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let p = session(&root, "crash", true, false);
        let mut s: CallSession = analysis::read(&p.join("session.json")).unwrap();
        s.active = true;
        s.mic_gaps.push(super::super::MicGap {
            start_ms: 1,
            resumed_ms: None,
        });
        analysis::write(&p.join("session.json"), &s).unwrap();
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(p.join("system.wav"))
            .unwrap();
        for _ in 0..160 {
            file.write_all(&0.2f32.to_le_bytes()).unwrap();
        }
        file.write_all(&[0, 0]).unwrap();
        drop(file);
        wav(&p.join("mic-0.wav"), 160);
        recover(&root).unwrap();
        let s: CallSession = analysis::read(&p.join("session.json")).unwrap();
        assert!(!s.active);
        assert!(s.recovered_at.is_some());
        assert_eq!(s.notes, "Keep my notes");
        assert_eq!(s.system.samples, 320);
        assert_eq!(s.elapsed_ms, 20);
        assert_eq!(s.mic_segments.len(), 1);
        assert_eq!(s.mic_gaps[0].resumed_ms, Some(20));
        let reader = hound::WavReader::open(p.join("system.wav")).unwrap();
        assert_eq!(reader.len(), 320);
        let bytes = fs::read(p.join("session.json")).unwrap();
        recover(&root).unwrap();
        assert_eq!(bytes, fs::read(p.join("session.json")).unwrap());
    }
    #[test]
    fn corrupt_manifest_uses_pending_notes_and_keeps_original() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let p = session(&root, "corrupt", false, false);
        let s = CallSession {
            id: "corrupt".into(),
            active: true,
            notes: "Newest draft".into(),
            ..Default::default()
        };
        fs::write(p.join("session.json"), b"{broken").unwrap();
        analysis::write(&p.join("session.tmp"), &s).unwrap();
        recover(&root).unwrap();
        let s: CallSession = analysis::read(&p.join("session.json")).unwrap();
        assert_eq!(s.notes, "Newest draft");
        assert!(!s.active);
        assert_eq!(
            fs::read(p.join("session.damaged.json")).unwrap(),
            b"{broken"
        );
    }
    #[test]
    fn missing_manifest_recovers_audio_but_closed_calls_are_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let closed = session(&root, "closed", false, true);
        let before = fs::read(closed.join("session.json")).unwrap();
        let lost = session(&root, "lost", true, false);
        fs::remove_file(lost.join("session.json")).unwrap();
        recover(&root).unwrap();
        let s: CallSession = analysis::read(&lost.join("session.json")).unwrap();
        assert_eq!(s.system.samples, 160);
        assert!(s.recovered_at.is_some());
        assert_eq!(before, fs::read(closed.join("session.json")).unwrap());
    }
    #[test]
    fn recovery_keeps_missing_channel_errors_and_orders_segments_numerically() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let p = session(&root, "partial-capture", true, false);
        let mut s: CallSession = analysis::read(&p.join("session.json")).unwrap();
        s.active = true;
        s.mic_segments.push(MicSegment {
            file: "mic-0.wav".into(),
            offset_ms: 0,
            stats: TrackStats::default(),
        });
        analysis::write(&p.join("session.json"), &s).unwrap();
        fs::remove_file(p.join("system.wav")).unwrap();
        wav(&p.join("mic-10.wav"), 160);
        wav(&p.join("mic-2.wav"), 160);
        recover(&root).unwrap();
        let s: CallSession = analysis::read(&p.join("session.json")).unwrap();
        assert!(s.system.error.is_some());
        assert!(s.mic_segments[0].stats.error.is_some());
        assert_eq!(s.mic_segments[1].file, "mic-2.wav");
        assert_eq!(s.mic_segments[2].file, "mic-10.wav");
        assert_eq!(s.mic_segments[2].offset_ms, 10);
        assert!(!s.active);
        assert!(s.recovered_at.is_some());
    }
    #[test]
    fn expiry_only_removes_new_completed_audio_and_keeps_text() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let ready = session(&root, "ready", true, true);
        let legacy = session(&root, "legacy", false, true);
        let failed = session(&root, "failed", true, false);
        let busy = session(&root, "busy", true, true);
        maintain(&root, &[], 0, 100).unwrap();
        assert!(ready.join("system.wav").exists());
        maintain(&root, &["busy".into()], 0, 100 + LIFETIME).unwrap();
        assert!(!ready.join("system.wav").exists());
        assert!(status(&ready).unwrap().expired);
        for p in [&legacy, &failed, &busy] {
            assert!(p.join("system.wav").exists());
        }
        assert!(
            analysis::read::<analysis::Transcript>(&ready.join("transcript.json"))
                .unwrap()
                .complete
        );
        assert_eq!(
            fs::read(ready.join("summary.json")).unwrap(),
            b"Keep edited summary"
        );
        assert_eq!(
            analysis::read::<CallSession>(&ready.join("session.json"))
                .unwrap()
                .notes,
            "Keep my notes"
        );
    }
    #[test]
    fn pressure_expires_oldest_safe_audio_early_but_reserves_space() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let old = session(&root, "old", true, true);
        maintain(&root, &[], 0, 100).unwrap();
        let new = session(&root, "new", true, true);
        maintain(&root, &[], 0, 200).unwrap();
        let legacy = session(&root, "legacy", false, false);
        fs::OpenOptions::new()
            .write(true)
            .open(legacy.join("system.wav"))
            .unwrap()
            .set_len(AUDIO_BUDGET - CALL_RESERVE - 1000)
            .unwrap();
        maintain(&root, &[], CALL_RESERVE, 300).unwrap();
        assert!(!old.join("system.wav").exists());
        assert!(new.join("system.wav").exists());
    }
    #[test]
    fn full_protected_archive_refuses_new_capture_without_deleting_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let legacy = session(&root, "legacy", false, false);
        fs::OpenOptions::new()
            .write(true)
            .open(legacy.join("system.wav"))
            .unwrap()
            .set_len(AUDIO_BUDGET)
            .unwrap();
        assert!(maintain(&root, &[], CALL_RESERVE, 100).is_err());
        assert!(legacy.join("system.wav").exists());
    }
    #[test]
    fn stale_and_active_transcripts_cannot_authorize_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let active = session(&root, "active", true, true);
        let stale = session(&root, "stale", true, true);
        let mut s: CallSession = analysis::read(&active.join("session.json")).unwrap();
        s.active = true;
        analysis::write(&active.join("session.json"), &s).unwrap();
        let mut s: CallSession = analysis::read(&stale.join("session.json")).unwrap();
        s.elapsed_ms = 42;
        analysis::write(&stale.join("session.json"), &s).unwrap();
        maintain(&root, &[], 0, LIFETIME * 2).unwrap();
        assert!(active.join("system.wav").exists());
        assert!(stale.join("system.wav").exists());
    }
    #[test]
    fn partial_expiry_retries_and_links_never_escape_archive() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let p = session(&root, "partial", true, true);
        wav(&p.join("mic-0.wav"), 160);
        analysis::write(
            &p.join("retention.json"),
            &Retention {
                version: 1,
                completed_at: Some(100),
                deletion_started_at: Some(101),
                deleted_at: None,
            },
        )
        .unwrap();
        fs::remove_file(p.join("mic-0.wav")).unwrap();
        maintain(&root, &[], 0, 102).unwrap();
        assert!(!p.join("system.wav").exists());
        let outside = tempfile::tempdir().unwrap();
        wav(&outside.path().join("outside.wav"), 160);
        let before = fs::read(outside.path().join("outside.wav")).unwrap();
        symlink(outside.path().join("outside.wav"), p.join("system.wav")).unwrap();
        assert!(recover_wav(&p.join("system.wav")).is_err());
        assert!(maintain(&root, &[], CALL_RESERVE, 999).is_err());
        assert_eq!(
            before,
            fs::read(outside.path().join("outside.wav")).unwrap()
        );
    }
}
