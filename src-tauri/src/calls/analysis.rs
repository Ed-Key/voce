//! Offline post-call jobs, isolated from dictation and its model lifecycle.
use super::{archive, CallNotesManager, CallSession};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

// A dense 90-minute transcript (one row a second per track, kept as chunks, raw entries and entries) is
// about 5 MB; 16 MiB leaves room for denser speech.
const MAX_JSON: u64 = 16 * 1024 * 1024;
// A worker runs at most a whole call plus time to finish its transcript and summary.
const WORKER_DEADLINE: Duration = Duration::from_secs(super::archive::MAX_CALL_SECONDS + 30 * 60);
#[derive(Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct Entry {
    pub id: u32,
    pub source: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}
#[derive(Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct Transcript {
    pub recording_key: String,
    #[serde(default)]
    pub version: String,
    pub complete: bool,
    pub entries: Vec<Entry>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct Point {
    pub text: String,
    pub sources: Vec<u32>,
}
#[derive(Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct Sections {
    pub overview: Vec<Point>,
    pub decisions: Vec<Point>,
    pub action_items: Vec<Point>,
    pub open_questions: Vec<Point>,
}
#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct Summary {
    pub job_id: String,
    pub recording_key: String,
    pub notes_key: String,
    pub transcript_version: String,
    pub sections: Sections,
    pub edited_text: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Job {
    job_id: String,
    recording_key: String,
    notes_key: String,
    status: String,
    error: Option<String>,
}
impl Default for Job {
    fn default() -> Self {
        Self {
            job_id: String::new(),
            recording_key: String::new(),
            notes_key: String::new(),
            status: "idle".into(),
            error: None,
        }
    }
}
#[derive(Default, Deserialize)]
struct Progress {
    status: String,
    done: u32,
    total: u32,
    error: Option<String>,
}
#[derive(Serialize, specta::Type)]
pub struct View {
    pub audio: archive::AudioStatus,
    pub status: String,
    pub error: Option<String>,
    pub done: u32,
    pub total: u32,
    pub transcript: Option<Transcript>,
    pub summary: Option<Summary>,
    pub outdated: bool,
}
#[derive(Serialize, Deserialize)]
struct Runtime {
    python: PathBuf,
    asr_model: PathBuf,
    summary_runtime: PathBuf,
    summary_model: PathBuf,
    /// Optional live streaming engine (stream-asr/setup.sh). The worker checks both and falls back to
    /// Whisper live windows when either is missing or unusable; post-call work never reads them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stream_asr: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stream_models: Option<PathBuf>,
}
#[derive(Default)]
struct Queue {
    ids: VecDeque<String>,
    current: Option<String>,
}
struct Inner {
    root: PathBuf,
    replay_root: PathBuf,
    script: PathBuf,
    runtime: PathBuf,
    queue: Mutex<Queue>,
    child: Mutex<Option<Child>>,
    foreground: AtomicBool,
    quiet_until: Mutex<Instant>,
    interrupted: AtomicBool,
    shutdown: AtomicBool,
    follow_target: Mutex<Option<String>>,
    live_worker: AtomicBool,
    /// Output folder of the live worker, where it says which engine it runs (live-mode.json).
    live_output: Mutex<Option<PathBuf>>,
    live_starting: AtomicBool,
}
pub struct CallAiManager {
    inner: Arc<Inner>,
}
impl Drop for CallAiManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(super) fn read<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || meta.len() > MAX_JSON {
        return Err("Invalid or oversized local call document".into());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
pub(super) fn write(path: &Path, value: &impl Serialize) -> Result<(), String> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_JSON {
        return Err("Local call document exceeds its size limit".into());
    }
    let tmp = path.with_extension(format!(
        "{}.ai-tmp",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}
fn key(value: &impl Serialize) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap_or_default())
    )
}
pub(super) fn recording_key(session: &CallSession) -> String {
    key(&(
        session.elapsed_ms,
        &session.system,
        &session.mic_segments,
        &session.mic_gaps,
    ))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-' || c == b'.')
        && !id.contains("..")
}
pub(super) fn folder(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid call identity".into());
    }
    let path = root.join(id);
    if std::fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
        || path.canonicalize().map_err(|e| e.to_string())?.parent() != Some(root)
    {
        return Err("Call folder is outside the private archive".into());
    }
    Ok(path)
}
fn optional<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if path.exists() {
        read(path).map(Some)
    } else {
        Ok(None)
    }
}
fn busy(status: &str) -> bool {
    matches!(status, "queued" | "running" | "paused")
}
/// Whether a live worker should hold off: always while dictating, and for the quiet period after dictation.
fn live_held(inner: &Inner) -> bool {
    inner.foreground.load(Ordering::Acquire)
        || (!inner.live_starting.load(Ordering::Acquire)
            && inner
                .quiet_until
                .lock()
                .map_or(true, |t| Instant::now() < *t))
}
fn interrupt(inner: &Inner) {
    inner.interrupted.store(true, Ordering::Release);
    if let Ok(mut until) = inner.quiet_until.lock() {
        *until = Instant::now() + Duration::from_secs(8);
    }
    stop_child(inner);
}
/// The live worker said it streams (live-mode.json): it runs on the Neural Engine, not the GPU dictation uses.
fn streaming_live(inner: &Inner) -> bool {
    if !inner.live_worker.load(Ordering::Acquire) {
        return false;
    }
    let Some(output) = inner.live_output.lock().ok().and_then(|o| o.clone()) else {
        return false;
    };
    optional::<serde_json::Value>(&output.join("live-mode.json"))
        .ok()
        .flatten()
        .is_some_and(|mode| mode["mode"] == "streaming")
}
fn stop_child(inner: &Inner) {
    if let Ok(child) = inner.child.lock() {
        if let Some(child) = child.as_ref() {
            // The owned worker starts a process group, including its model runtime.
            unsafe {
                kill(-(child.id() as i32), 9);
            }
        }
    }
}
extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}
impl CallAiManager {
    pub(super) fn follow(&self, id: &str) -> Result<(), String> {
        *self.inner.follow_target.lock().map_err(|e| e.to_string())? = Some(id.to_owned());
        self.inner.interrupted.store(true, Ordering::Release);
        stop_child(&self.inner);
        // Starting a call interrupts background work, and that quiet period still holds jobs back. The live
        // transcript alone skips it, or it would start 8 seconds into every call.
        self.inner.live_starting.store(true, Ordering::Release);
        let inner = self.inner.clone();
        let id = id.to_owned();
        std::thread::Builder::new().name("call-live-feed".into()).spawn(move || {
            let result = run_local(&inner, &id, true, true);
            let status = match result {
                Ok(value) => serde_json::json!({"status":"complete","result":value}),
                Err(_) => serde_json::json!({"status":"failed","error":"Local live transcription stopped. Recording is independent; saved audio remains available for post-call processing."}),
            };
            if let Ok(path) = folder(&inner.root, &id) { let _ = write(&path.join("live-feed.json"), &status); }
        }).map(|_| ()).map_err(|e| e.to_string())
    }
    pub(super) fn maintain_audio(&self, reserve: u64) -> Result<(), String> {
        let queue = self.inner.queue.lock().map_err(|e| e.to_string())?;
        let mut protected: Vec<String> = queue.ids.iter().cloned().collect();
        protected.extend(queue.current.iter().cloned());
        archive::maintain(&self.inner.root, &protected, reserve, archive::now())
    }
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let root = data
            .join("calls")
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let script = data.join("call-worker-v1.py");
        std::fs::write(&script, include_str!("worker.py")).map_err(|e| e.to_string())?;
        let inner = Arc::new(Inner {
            root,
            replay_root: data.join("call-feed-replays"),
            script,
            runtime: data.join("call-ai-runtime.json"),
            queue: Mutex::new(Queue::default()),
            child: Mutex::new(None),
            foreground: AtomicBool::new(false),
            quiet_until: Mutex::new(Instant::now() + Duration::from_secs(5)),
            interrupted: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            follow_target: Mutex::new(None),
            live_worker: AtomicBool::new(false),
            live_output: Mutex::new(None),
            live_starting: AtomicBool::new(false),
        });
        for session in list(&inner.root)? {
            let path = folder(&inner.root, &session.id)?;
            if !session.active
                && optional::<Job>(&path.join("analysis.json"))
                    .ok()
                    .flatten()
                    .is_some_and(|j| busy(&j.status))
            {
                inner
                    .queue
                    .lock()
                    .map_err(|e| e.to_string())?
                    .ids
                    .push_back(session.id);
            }
        }
        let unsummarized = list(&inner.root)?
            .into_iter()
            .filter(|session| needs_summary(&inner, session))
            .map(|session| session.id)
            .collect::<Vec<_>>();
        let manager = Self { inner };
        // Calls that ended without a summary: older ones, or ones whose job was cut short.
        for id in unsummarized {
            if let Err(error) = manager.enqueue(&id) {
                log::warn!("Queue summary: {error}");
            }
        }
        let inner = manager.inner.clone();
        let worker = inner.clone();
        let app = app.clone();
        std::thread::Builder::new()
            .name("call-ai".into())
            .spawn(move || work(worker, app))
            .map_err(|e| e.to_string())?;
        Ok(manager)
    }
    pub fn foreground(&self, active: bool) {
        let previous = self.inner.foreground.swap(active, Ordering::AcqRel);
        if active {
            self.inner.live_starting.store(false, Ordering::Release);
        }
        // Call work is stopped so it never competes with dictation. A streaming live worker runs on the
        // Neural Engine and light CPU, not the GPU dictation uses, so it keeps following the call.
        if active && !streaming_live(&self.inner) {
            self.interrupt();
        } else if previous {
            if let Ok(mut until) = self.inner.quiet_until.lock() {
                let settle = if self.inner.live_worker.load(Ordering::Acquire) {
                    Duration::from_millis(250)
                } else {
                    Duration::from_secs(5)
                };
                *until = Instant::now() + settle;
            }
        }
    }
    pub fn interrupt(&self) {
        interrupt(&self.inner);
    }
    pub fn shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::Release);
        stop_child(&self.inner);
    }
    pub(super) fn enqueue(&self, id: &str) -> Result<(), String> {
        let mut queue = self.inner.queue.lock().map_err(|e| e.to_string())?;
        let path = folder(&self.inner.root, id)?;
        let session: CallSession = read(&path.join("session.json"))?;
        if session.active {
            return Err("Stop recording before creating a transcript".into());
        }
        let existing = optional::<Job>(&path.join("analysis.json"))?.unwrap_or_default();
        if busy(&existing.status) {
            return Ok(());
        }
        let job = Job {
            job_id: chrono::Utc::now().format("%Y%m%dT%H%M%S%f").to_string(),
            recording_key: recording_key(&session),
            notes_key: key(&session.notes),
            status: "queued".into(),
            error: None,
        };
        write(&path.join("analysis.json"), &job)?;
        if !queue.ids.iter().any(|x| x == id) {
            queue.ids.push_back(id.into());
        }
        Ok(())
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut queue = self.inner.queue.lock().map_err(|e| e.to_string())?;
        let path = folder(&self.inner.root, id)?;
        let mut job = optional::<Job>(&path.join("analysis.json"))?.unwrap_or_default();
        job.status = "cancelled".into();
        job.error = None;
        write(&path.join("analysis.json"), &job)?;
        queue.ids.retain(|x| x != id);
        if queue.current.as_deref() == Some(id) {
            stop_child(&self.inner);
        }
        Ok(())
    }
    fn view(&self, id: &str) -> Result<View, String> {
        let path = folder(&self.inner.root, id)?;
        let session: CallSession = read(&path.join("session.json"))?;
        let job = optional::<Job>(&path.join("analysis.json"))?.unwrap_or_default();
        let progress = if job.status == "running" {
            optional::<Progress>(&path.join(format!("progress-{}.json", job.job_id)))?
                .unwrap_or_default()
        } else {
            Progress::default()
        };
        let transcript: Option<Transcript> = optional(&path.join("transcript.json"))?;
        let summary: Option<Summary> = optional(&path.join("summary.json"))?;
        let outdated = summary.as_ref().is_some_and(|s| {
            s.notes_key != key(&session.notes)
                || s.recording_key != recording_key(&session)
                || transcript
                    .as_ref()
                    .is_none_or(|t| t.version != s.transcript_version)
        });
        Ok(View {
            audio: archive::status(&path)?,
            status: if progress.status.is_empty() {
                job.status
            } else {
                progress.status
            },
            error: progress.error.or(job.error),
            done: progress.done,
            total: progress.total,
            transcript,
            summary,
            outdated,
        })
    }
    fn save_notes(&self, id: &str, notes: String) -> Result<(), String> {
        if notes.len() > 256 * 1024 {
            return Err("Notes exceed 256 KiB".into());
        }
        let queue = self.inner.queue.lock().map_err(|e| e.to_string())?;
        let path = folder(&self.inner.root, id)?;
        let mut session: CallSession = read(&path.join("session.json"))?;
        if session.active {
            return Err("Use the active recorder to save live notes".into());
        }
        if session.notes == notes {
            return Ok(());
        }
        session.notes = notes;
        write(&path.join("session.json"), &session)?;
        if let Some(mut job) = optional::<Job>(&path.join("analysis.json"))? {
            if busy(&job.status) {
                job.status = "outdated".into();
                write(&path.join("analysis.json"), &job)?;
                if queue.current.as_deref() == Some(id) {
                    stop_child(&self.inner);
                }
            }
        }
        Ok(())
    }
    fn save_summary(&self, id: &str, expected_job: &str, text: String) -> Result<(), String> {
        if text.len() > 64 * 1024 {
            return Err("Summary exceeds 64 KiB".into());
        }
        let _queue = self.inner.queue.lock().map_err(|e| e.to_string())?;
        let path = folder(&self.inner.root, id)?;
        if optional::<Job>(&path.join("analysis.json"))?.is_some_and(|j| busy(&j.status)) {
            return Err("Wait for generation or cancel it before editing the summary".into());
        }
        let mut summary: Summary = read(&path.join("summary.json"))?;
        if summary.job_id != expected_job {
            return Err("The summary changed. Reopen it before saving edits".into());
        }
        summary.edited_text = Some(text);
        write(&path.join("summary.json"), &summary)
    }
}
/// The transcript heard during the call, from its newest run.
fn live_transcript(inner: &Inner, id: &str) -> Option<PathBuf> {
    std::fs::read_dir(&inner.replay_root)
        .ok()?
        .flatten()
        .filter(|run| {
            read::<serde_json::Value>(&run.path().join("request.json"))
                .is_ok_and(|request| request["session"]["id"] == id)
        })
        .filter_map(|run| {
            let transcript = run.path().join("transcript.json");
            let made = transcript.metadata().ok()?.modified().ok()?;
            Some((made, transcript))
        })
        .max_by_key(|(made, _)| *made)
        .map(|(_, transcript)| transcript)
}
/// Everything a saved call left on disk, its own folder last: if a move fails partway the call is still listed.
fn call_parts(inner: &Inner, id: &str, path: &Path) -> Result<Vec<PathBuf>, String> {
    let data = inner.root.parent().ok_or("Call data unavailable")?;
    let runs = |root: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .map(|entry| entry.path())
            .collect()
    };
    let mut parts = Vec::new();
    for run in runs(&inner.replay_root) {
        let Ok(request) = read::<serde_json::Value>(&run.join("request.json")) else {
            continue;
        };
        if request["session"]["id"] == id {
            if let Some(feed) = request["feed"]["run_id"].as_str().filter(|r| valid_id(r)) {
                parts.push(data.join("assistie-local").join(feed));
            }
            parts.push(run);
        }
    }
    for run in runs(&data.join("assistie")) {
        if let Ok(state) = read::<serde_json::Value>(&run.join("state.json")) {
            if state["call_binding"]["call_id"] == id {
                parts.push(run);
            }
        }
    }
    parts.retain(|part| part.is_dir());
    parts.push(path.to_path_buf());
    Ok(parts)
}
/// `detach_runs` clears a store's active pointer, which its next session would reopen, and is harmless if the delete
/// then fails. `forget_runs` drops the runs from its catalog once they are gone.
fn tell_store(store: &Path, command: &str, parts: &[PathBuf]) -> Result<(), String> {
    let runs: Vec<_> = parts
        .iter()
        .filter(|part| part.parent() == Some(store))
        .filter_map(|part| part.file_name()?.to_str())
        .collect();
    if runs.is_empty() || !store.join("registry.json").exists() {
        return Ok(());
    }
    super::assistie::exchange_at(store, command, None, serde_json::json!({"runs":runs})).map(|_| ())
}
/// Moves a finished call and everything it left to the Trash. Handy never hard-deletes meeting data. Any failure
/// puts everything back, so a call is either gone whole or still works.
fn trash_call(inner: &Inner, trash: &Path, id: &str, active: Option<&str>) -> Result<(), String> {
    let path = folder(&inner.root, id)?;
    let session: CallSession = read(&path.join("session.json"))?;
    if session.active || active == Some(id) {
        return Err("Stop the call before deleting it".into());
    }
    // Stop returns before the worker and Terra finish writing to this call's folders.
    let ended = chrono::DateTime::parse_from_rfc3339(&session.started_at)
        .map(|started| started.timestamp_millis() + session.elapsed_ms as i64)
        .unwrap_or(0);
    if chrono::Utc::now().timestamp_millis() < ended + DELETE_SETTLE_MS {
        return Err("This call just ended. Try again in a moment".into());
    }
    // Capture shares this lock, so it is released before any slow work, with the call off the queue.
    let queued = {
        let mut queue = inner.queue.lock().map_err(|e| e.to_string())?;
        if queue.current.as_deref() == Some(id) {
            return Err("This call is still being processed. Try again when it finishes".into());
        }
        let queued = queue.ids.iter().any(|x| x == id);
        queue.ids.retain(|x| x != id);
        queued
    };
    let requeue = || {
        if queued {
            if let Ok(mut queue) = inner.queue.lock() {
                queue.ids.push_back(id.into());
            }
        }
    };
    let parts = match call_parts(inner, id, &path) {
        Ok(parts) => parts,
        Err(error) => {
            requeue();
            return Err(error);
        }
    };
    let data = inner.root.parent().ok_or("Call data unavailable")?;
    let mut target = trash.join(format!("Voce call {id}"));
    while target.exists() {
        target.set_file_name(format!(
            "Voce call {id} {}",
            chrono::Utc::now().format("%H%M%S%f")
        ));
    }
    if let Err(error) = std::fs::create_dir_all(&target) {
        requeue();
        return Err(error.to_string());
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = tell_store(&data.join("assistie"), "detach_runs", &parts)
        .and_then(|()| tell_store(&data.join("assistie-local"), "detach_runs", &parts))
        .and_then(|()| {
            parts.iter().enumerate().try_for_each(|(index, part)| {
                let name = part.file_name().ok_or("Invalid call data")?;
                let parent = part
                    .parent()
                    .and_then(Path::file_name)
                    .ok_or("Invalid call data")?;
                let place = target.join(format!(
                    "{index}-{}-{}",
                    parent.to_string_lossy(),
                    name.to_string_lossy()
                ));
                std::fs::rename(part, &place).map_err(|e| e.to_string())?;
                moved.push((part.clone(), place));
                Ok::<(), String>(())
            })
        });
    if let Err(error) = result {
        for (part, place) in moved.iter().rev() {
            let _ = std::fs::rename(place, part);
        }
        let _ = std::fs::remove_dir(&target);
        requeue();
        return Err(error);
    }
    // The call is gone: a stale catalog row names no folder and holds no meeting text.
    for store in ["assistie", "assistie-local"] {
        if let Err(error) = tell_store(&data.join(store), "forget_runs", &parts) {
            log::warn!("Forget deleted call's runs: {error}");
        }
    }
    Ok(())
}
fn needs_summary(inner: &Inner, session: &CallSession) -> bool {
    let Ok(path) = folder(&inner.root, &session.id) else {
        return false;
    };
    let status = optional::<Job>(&path.join("analysis.json"))
        .ok()
        .flatten()
        .map(|job| job.status);
    !session.active
        && session.elapsed_ms > super::SUMMARY_MIN_MS
        && !session.id.starts_with("fictional-")
        && !path.join("summary.json").exists()
        && matches!(status.as_deref(), None | Some("failed"))
        && (live_transcript(inner, &session.id).is_some() || path.join("transcript.json").exists())
}
const DELETE_SETTLE_MS: i64 = 30_000;
const DEFAULT_TITLE: &str = "Call notes";
#[derive(Deserialize)]
struct CallTitle {
    title: String,
}
fn list(root: &Path) -> Result<Vec<CallSession>, String> {
    let mut sessions = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        if let Ok(mut session) = read::<CallSession>(&entry.path().join("session.json")) {
            if session.title == DEFAULT_TITLE {
                if let Ok(named) = read::<CallTitle>(&entry.path().join("title.json")) {
                    session.title = named.title;
                }
            }
            sessions.push(session);
        }
    }
    sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(sessions)
}
/// Names a finished call from its transcript, without holding up the next call. The local model reaches nothing
/// but its own socket, and a failure only leaves the call under its plain name.
fn name_call(inner: &Inner, call: &Path, transcript: &Path) {
    use std::os::unix::process::CommandExt;
    let Ok(runtime) = runtime(inner) else {
        return;
    };
    if call.join("title.json").exists() {
        return;
    }
    let child = Command::new("/usr/bin/sandbox-exec")
        .args([
            "-p",
            "(version 1) (allow default) (deny network*) (allow network* (local unix-socket) (remote unix-socket))",
        ])
        .arg(&runtime.python)
        .args(["-I", "-B", "-u"])
        .arg(&inner.script)
        .arg("--title")
        .arg(call)
        .arg(transcript)
        .arg(&inner.runtime)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
    if let Ok(mut child) = child {
        std::thread::spawn(move || child.wait());
    }
}
fn runtime(inner: &Inner) -> Result<Runtime, String> {
    let value: Runtime = read(&inner.runtime).map_err(|_| "Local AI runtime configuration is missing. The dev setup needs its existing Python, Whisper and summary model paths".to_string())?;
    for path in [&value.python, &value.summary_runtime, &value.summary_model] {
        if !path.is_absolute() || !path.is_file() {
            return Err("A configured local AI runtime or model is unavailable".into());
        }
    }
    if !value.asr_model.is_absolute() || !value.asr_model.join("config.json").is_file() {
        return Err("The configured local Whisper model is unavailable".into());
    }
    Ok(value)
}
fn finish(inner: &Inner, path: &Path, mut job: Job, success: bool) -> Result<(), String> {
    let session: CallSession = read(&path.join("session.json"))?;
    let current: Job = read(&path.join("analysis.json"))?;
    if current.job_id != job.job_id || matches!(current.status.as_str(), "cancelled" | "outdated") {
        return Ok(());
    }
    if job.notes_key != key(&session.notes) || job.recording_key != recording_key(&session) {
        job.status = "outdated".into();
    } else if inner.interrupted.swap(false, Ordering::AcqRel)
        || inner.shutdown.load(Ordering::Acquire)
    {
        job.status = "paused".into();
    } else if success {
        let summary: Summary = read(&path.join(format!("result-{}.json", job.job_id)))?;
        let transcript: Transcript = read(&path.join("transcript.json"))?;
        if !transcript.complete
            || summary.job_id != job.job_id
            || summary.notes_key != job.notes_key
            || summary.recording_key != job.recording_key
            || summary.transcript_version != transcript.version
        {
            return Err("An outdated local result was rejected".into());
        }
        for points in [
            &summary.sections.overview,
            &summary.sections.decisions,
            &summary.sections.action_items,
            &summary.sections.open_questions,
        ] {
            if points.len() > 12
                || points.iter().any(|p| {
                    p.text.len() > 6400
                        || p.sources
                            .iter()
                            .any(|id| !transcript.entries.iter().any(|e| e.id == *id))
                })
            {
                return Err("The summary returned invalid source references".into());
            }
        }
        write(&path.join("summary.json"), &summary)?;
        name_call(inner, path, &path.join("transcript.json"));
        job.status = "ready".into();
        job.error = None;
    } else {
        job.status = "failed".into();
        job.error = optional::<Progress>(&path.join(format!("progress-{}.json", job.job_id)))?.and_then(|p| p.error).or(Some("Local processing stopped unexpectedly. Your recording and previous results are retained".into()));
    }
    write(&path.join("analysis.json"), &job)
}
struct AttemptFiles {
    temporary: PathBuf,
    files: Vec<PathBuf>,
}
impl Drop for AttemptFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.temporary);
        for file in &self.files {
            let _ = std::fs::remove_file(file);
        }
    }
}
fn execute(inner: &Inner, path: &Path, job: &Job) -> Result<(), String> {
    use std::os::unix::{fs::DirBuilderExt, process::CommandExt};
    let runtime = runtime(inner)?;
    let session: CallSession = read(&path.join("session.json"))?;
    let temporary = PathBuf::from("/tmp").join(format!(
        "handy-job-{}-{}",
        job.job_id,
        chrono::Utc::now().timestamp_subsec_nanos()
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&temporary)
        .map_err(|e| e.to_string())?;
    let request = path.join(format!("request-{}.json", job.job_id));
    let _files = AttemptFiles {
        temporary: temporary.clone(),
        files: vec![
            request.clone(),
            path.join(format!("result-{}.json", job.job_id)),
            path.join(format!("progress-{}.json", job.job_id)),
        ],
    };
    write(
        &request,
        &serde_json::json!({"job_id":job.job_id,"recording_key":job.recording_key,"notes_key":job.notes_key,"notes":session.notes,"session":session,"runtime":runtime,"temporary":temporary,"live_transcript":live_transcript(inner, &session.id)}),
    )?;
    {
        let _queue = inner.queue.lock().map_err(|e| e.to_string())?;
        let current: Job = read(&path.join("analysis.json"))?;
        if current.job_id != job.job_id || current.status != "running" {
            return Ok(());
        }
        let mut child = inner.child.lock().map_err(|e| e.to_string())?;
        // Pair launch and interruption under the same lock. A shortcut arriving
        // after this check waits only until spawn, then kills the whole group.
        inner.interrupted.store(false, Ordering::Release);
        if inner.foreground.load(Ordering::Acquire)
            || inner.shutdown.load(Ordering::Acquire)
            || inner
                .quiet_until
                .lock()
                .map_or(true, |t| Instant::now() < *t)
        {
            inner.interrupted.store(true, Ordering::Release);
        } else {
            *child = Some(
                Command::new(&runtime.python)
                    .args(["-I", "-u"])
                    .arg(&inner.script)
                    .arg(&request)
                    .env("HF_HUB_OFFLINE", "1")
                    .env("HF_HUB_DISABLE_TELEMETRY", "1")
                    .env("VECLIB_MAXIMUM_THREADS", "2")
                    .env("OMP_NUM_THREADS", "2")
                    .env("TOKENIZERS_PARALLELISM", "false")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .process_group(0)
                    .spawn()
                    .map_err(|e| e.to_string())?,
            );
        }
    }
    let success = await_worker(inner)?;
    let _queue = inner.queue.lock().map_err(|e| e.to_string())?;
    finish(inner, path, job.clone(), success)
}
fn await_worker(inner: &Inner) -> Result<bool, String> {
    let started = Instant::now();
    let success = loop {
        if started.elapsed() > WORKER_DEADLINE {
            stop_child(inner);
        }
        // A streaming worker left running through dictation that falls back to Whisper (GPU) mid-dictation
        // is stopped as dictation would have stopped it.
        if inner.foreground.load(Ordering::Acquire)
            && inner.live_worker.load(Ordering::Acquire)
            && !inner.interrupted.load(Ordering::Acquire)
            && !streaming_live(inner)
        {
            interrupt(inner);
        }
        let mut slot = inner.child.lock().map_err(|e| e.to_string())?;
        let Some(child) = slot.as_mut() else {
            break false;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                slot.take();
                break status.success();
            }
            Ok(None) => (),
            Err(error) => {
                unsafe {
                    kill(-(child.id() as i32), 9);
                }
                let _ = child.wait();
                slot.take();
                return Err(error.to_string());
            }
        }
        drop(slot);
        std::thread::sleep(Duration::from_millis(150));
    };
    Ok(success)
}

#[derive(Serialize, Deserialize, specta::Type)]
pub struct LocalReplay {
    #[serde(default)]
    run_id: String,
    complete: bool,
    entries: u32,
    feed_segments: u32,
    feed_sequence: u32,
    version: u32,
    local_only: bool,
    sharing: bool,
    live_style: bool,
    following: bool,
    processing_ms: u64,
    first_update_ms: Option<u64>,
    max_lag_ms: Option<u64>,
}

struct ReplaySlot<'a>(&'a Inner);
impl Drop for ReplaySlot<'_> {
    fn drop(&mut self) {
        if let Ok(mut queue) = self.0.queue.lock() {
            if let Ok(mut slot) = self.0.child.lock() {
                if let Some(mut child) = slot.take() {
                    unsafe {
                        kill(-(child.id() as i32), 9);
                    }
                    let _ = child.wait();
                }
            }
            queue.current = None;
            self.0.live_worker.store(false, Ordering::Release);
            if let Ok(mut output) = self.0.live_output.lock() {
                *output = None;
            }
        }
    }
}

fn replay_local(inner: &Inner, id: &str, live_style: bool) -> Result<LocalReplay, String> {
    run_local(inner, id, live_style, false)
}

fn following_current(inner: &Inner, id: &str) -> bool {
    !inner.shutdown.load(Ordering::Acquire)
        && inner
            .follow_target
            .lock()
            .is_ok_and(|target| target.as_deref().is_none_or(|active| active == id))
}

fn run_local(
    inner: &Inner,
    id: &str,
    live_style: bool,
    following: bool,
) -> Result<LocalReplay, String> {
    use std::os::unix::{fs::DirBuilderExt, process::CommandExt};
    let source = folder(&inner.root, id)?;
    let mut session: CallSession = read(&source.join("session.json"))?;
    if (!following && session.active) || session.id != id {
        return Err("Choose a stopped saved call for local replay".into());
    }
    session.notes.clear();
    session.title.clear();
    let runtime: Runtime = read(&inner.runtime)?;
    if !runtime.python.is_absolute()
        || !runtime.python.is_file()
        || !runtime.asr_model.is_absolute()
        || !runtime.asr_model.join("config.json").is_file()
    {
        return Err("The existing local speech runtime is unavailable".into());
    }
    if following {
        let deadline = Instant::now() + Duration::from_secs(5);
        while inner
            .queue
            .lock()
            .map_err(|e| e.to_string())?
            .current
            .is_some()
        {
            if Instant::now() >= deadline || !following_current(inner, id) {
                return Err("Live worker slot unavailable".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    {
        let mut queue = inner.queue.lock().map_err(|e| e.to_string())?;
        if queue.current.is_some() || (!following && !queue.ids.is_empty()) {
            return Err("Wait for the current local call job before replaying".into());
        }
        queue.current = Some(id.into());
        inner.live_worker.store(following, Ordering::Release);
    }
    let _slot = ReplaySlot(inner);
    let root = inner
        .replay_root
        .parent()
        .ok_or("Replay store unavailable")?
        .join("assistie-local");
    super::assistie::prepare(&root)?;
    let binding = serde_json::json!({"call_id":id,"recording_key":recording_key(&session)});
    let value = super::assistie::exchange_at(&root, "create_local", None, binding)?;
    let run = value["run_id"]
        .as_str()
        .ok_or("Missing local replay identity")?
        .to_owned();
    let outcome = (|| {
        if following {
            write(
                &source.join("live-feed.json"),
                &serde_json::json!({"status":"following","run_id":run,"local_only":true}),
            )?;
        }
        if inner.replay_root.is_symlink() {
            return Err("Replay store must not be linked".into());
        }
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&inner.replay_root)
            .map_err(|e| e.to_string())?;
        let output = inner.replay_root.join(&run);
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&output)
            .map_err(|e| e.to_string())?;
        if following {
            *inner.live_output.lock().map_err(|e| e.to_string())? = Some(output.clone());
        }
        let request = output.join("request.json");
        write(
            &request,
            &serde_json::json!({"recording_key":recording_key(&session),"session":session,"runtime":runtime,"audio_folder":source,"live_style":live_style,"following":following,"feed":{"root":root,"run_id":run}}),
        )?;
        loop {
            while following && following_current(inner, id) && live_held(inner) {
                std::thread::sleep(Duration::from_millis(100));
            }
            {
                let mut child = inner.child.lock().map_err(|e| e.to_string())?;
                if following && !following_current(inner, id) {
                    return Err("The live call changed".into());
                }
                inner.interrupted.store(false, Ordering::Release);
                let held = if following {
                    live_held(inner)
                } else {
                    inner.foreground.load(Ordering::Acquire)
                        || inner
                            .quiet_until
                            .lock()
                            .map_or(true, |t| Instant::now() < *t)
                };
                if held || inner.shutdown.load(Ordering::Acquire) {
                    if following && !inner.shutdown.load(Ordering::Acquire) {
                        drop(child);
                        continue;
                    }
                    return Err("Local replay deferred for foreground dictation".into());
                }
                *child = Some(
                    Command::new("/usr/bin/sandbox-exec")
                        .args(["-p", "(version 1) (allow default) (deny network*)"])
                        .arg(&runtime.python)
                        .args(["-I", "-B", "-u"])
                        .arg(&inner.script)
                        .arg("--local-feed")
                        .arg(&request)
                        .env("HF_HUB_OFFLINE", "1")
                        .env("HF_HUB_DISABLE_TELEMETRY", "1")
                        .env("VECLIB_MAXIMUM_THREADS", "2")
                        .env("OMP_NUM_THREADS", "2")
                        .env("TOKENIZERS_PARALLELISM", "false")
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .process_group(0)
                        .spawn()
                        .map_err(|e| e.to_string())?,
                );
            }
            let success = await_worker(inner)?;
            if following
                && inner.interrupted.load(Ordering::Acquire)
                && following_current(inner, id)
            {
                continue;
            }
            if !success || inner.interrupted.load(Ordering::Acquire) {
                return Err(
                    "Local replay interrupted or failed. Partial output remains on this Mac".into(),
                );
            }
            break;
        }
        let mut result: LocalReplay = read(&output.join("local-feed-result.json"))?;
        if !result.complete
            || !result.local_only
            || result.sharing
            || result.live_style != live_style
            || result.following != following
        {
            return Err("Invalid local replay result".into());
        }
        result.run_id = run.clone();
        name_call(inner, &source, &output.join("transcript.json"));
        Ok(result)
    })();
    let stopped = super::assistie::exchange_at(&root, "stop", Some(&run), serde_json::json!({}));
    stopped?;
    outcome
}

fn work(inner: Arc<Inner>, app: AppHandle) {
    while !inner.shutdown.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(200));
        if inner.foreground.load(Ordering::Acquire)
            || inner
                .quiet_until
                .lock()
                .map_or(true, |t| Instant::now() < *t)
            || app
                .try_state::<CallNotesManager>()
                .is_some_and(|c| c.is_active())
        {
            continue;
        }
        let id = match inner.queue.lock() {
            Ok(mut q) => {
                if q.current.is_some() {
                    continue;
                }
                let id = q.ids.pop_front();
                q.current = id.clone();
                id
            }
            Err(_) => return,
        };
        let Some(id) = id else {
            continue;
        };
        let attempt = (|| -> Result<(), String> {
            let path = folder(&inner.root, &id)?;
            let job = {
                let _queue = inner.queue.lock().map_err(|e| e.to_string())?;
                let mut job: Job = read(&path.join("analysis.json"))?;
                if !busy(&job.status) {
                    return Ok(());
                }
                job.status = "running".into();
                write(&path.join("analysis.json"), &job)?;
                job
            };
            execute(&inner, &path, &job)
        })();
        if let Ok(mut queue) = inner.queue.lock() {
            if let Ok(path) = folder(&inner.root, &id) {
                if let Ok(mut job) = read::<Job>(&path.join("analysis.json")) {
                    if let Err(error) = attempt {
                        if job.status == "running" {
                            job.status = "failed".into();
                            job.error = Some(error);
                            let _ = write(&path.join("analysis.json"), &job);
                        }
                    }
                    if job.status == "paused" {
                        queue.ids.push_front(id);
                    }
                }
            }
            queue.current = None;
        }
    }
}
fn ai(app: &AppHandle) -> Result<tauri::State<'_, CallAiManager>, String> {
    app.try_state()
        .ok_or("Local call processing is unavailable".into())
}
#[tauri::command]
#[specta::specta]
pub async fn list_saved_calls(app: AppHandle) -> Result<Vec<CallSession>, String> {
    tauri::async_runtime::spawn_blocking(move || list(&ai(&app)?.inner.root))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
#[specta::specta]
pub async fn call_analysis(app: AppHandle, session_id: String) -> Result<View, String> {
    tauri::async_runtime::spawn_blocking(move || ai(&app)?.view(&session_id))
        .await
        .map_err(|e| e.to_string())?
}
/// The saved call's journals joined for the call page, as JSON. Empty lists when it has no journals.
fn observatory(root: &Path, id: &str) -> Result<String, String> {
    folder(root, id)?;
    let data = root
        .parent()
        .ok_or("The call archive has no parent folder")?;
    let output = std::process::Command::new("/usr/bin/python3")
        .args(["-I", "-B", "-c", include_str!("observatory.py")])
        .arg(data)
        .arg(id)
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("The call's logs could not be read".into());
    }
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}
#[tauri::command]
#[specta::specta]
pub async fn call_observatory(app: AppHandle, session_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || observatory(&ai(&app)?.inner.root, &session_id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
#[specta::specta]
pub async fn delete_call(app: AppHandle, session_id: String) -> Result<(), String> {
    let trash = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(".Trash");
    let active = app.state::<CallNotesManager>().active_session_id();
    tauri::async_runtime::spawn_blocking(move || {
        trash_call(&ai(&app)?.inner, &trash, &session_id, active.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
#[specta::specta]
pub async fn process_call(app: AppHandle, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ai(&app)?.enqueue(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn process_saved_call_local_feed(
    app: AppHandle,
    session_id: String,
    live_style: bool,
) -> Result<LocalReplay, String> {
    if app.config().identifier != crate::APP_ID
        || app
            .try_state::<CallNotesManager>()
            .is_some_and(|c| c.is_active())
    {
        return Err("Local replay requires Voce with recording stopped".into());
    }
    let inner = ai(&app)?.inner.clone();
    tauri::async_runtime::spawn_blocking(move || replay_local(&inner, &session_id, live_style))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
#[specta::specta]
pub async fn cancel_call_processing(app: AppHandle, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ai(&app)?.cancel(&session_id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
#[specta::specta]
pub async fn save_saved_call_notes(
    app: AppHandle,
    session_id: String,
    notes: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ai(&app)?.save_notes(&session_id, notes))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
#[specta::specta]
pub async fn save_call_summary(
    app: AppHandle,
    session_id: String,
    expected_job: String,
    text: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ai(&app)?.save_summary(&session_id, &expected_job, text)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_cover_a_full_length_call() {
        // The live worker must outlive the longest call, and a dense transcript of it must stay readable.
        assert!(
            WORKER_DEADLINE
                > Duration::from_secs(super::super::archive::MAX_CALL_SECONDS + 10 * 60)
        );
        let dense_rows = 2 * super::super::archive::MAX_CALL_SECONDS; // one row a second per track
        assert!(
            MAX_JSON > dense_rows * 3 * 300,
            "rows are stored three times, about 300 bytes each"
        );
    }

    #[test]
    fn post_call_jobs_keep_the_existing_dictation_quiet_interval() {
        let (manager, _) = fixture();
        manager.foreground(true);
        manager.foreground(false);
        let wait = manager
            .inner
            .quiet_until
            .lock()
            .unwrap()
            .saturating_duration_since(Instant::now());
        assert!(wait >= Duration::from_millis(4900) && wait <= Duration::from_secs(5));
    }

    #[test]
    fn replacement_call_stops_the_old_growing_worker() {
        let (manager, _) = fixture();
        let model = manager.inner.root.join("asr");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(model.join("config.json"), "{}").unwrap();
        write(
            &manager.inner.runtime,
            &Runtime {
                python: "/usr/bin/python3".into(),
                asr_model: model,
                summary_runtime: "unused".into(),
                summary_model: "unused".into(),
                stream_asr: None,
                stream_models: None,
            },
        )
        .unwrap();
        std::fs::write(&manager.inner.script, "import time\ntime.sleep(120)\n").unwrap();
        *manager.inner.follow_target.lock().unwrap() = Some("saved-call".into());
        let inner = manager.inner.clone();
        let job = std::thread::spawn(move || run_local(&inner, "saved-call", true, true));
        let deadline = Instant::now() + Duration::from_secs(5);
        while manager.inner.child.lock().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(manager.inner.child.lock().unwrap().is_some());
        *manager.inner.follow_target.lock().unwrap() = Some("replacement".into());
        manager.interrupt();
        assert!(job.join().unwrap().is_err());
        assert!(manager.inner.child.lock().unwrap().is_none());
        assert!(manager.inner.queue.lock().unwrap().current.is_none());
    }

    #[test]
    fn streaming_live_worker_keeps_running_through_dictation() {
        let (manager, path) = fixture();
        let model = manager.inner.root.join("asr");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(model.join("config.json"), "{}").unwrap();
        write(
            &manager.inner.runtime,
            &Runtime {
                python: "/usr/bin/python3".into(),
                asr_model: model,
                summary_runtime: "unused".into(),
                summary_model: "unused".into(),
                stream_asr: None,
                stream_models: None,
            },
        )
        .unwrap();
        // A worker that says it streams, counts its launches, and finishes once released.
        std::fs::write(&manager.inner.script,r#"import json,pathlib,sys,time
p=pathlib.Path(sys.argv[2]).parent
launches=p/'launches'
launches.write_text(str(int(launches.read_text())+1 if launches.exists() else 1))
(p/'live-mode.json').write_text(json.dumps({'mode':'streaming'}))
while not (p/'release').exists(): time.sleep(.02)
(p/'local-feed-result.json').write_text(json.dumps(dict(complete=True,entries=0,feed_segments=0,feed_sequence=0,version=1,local_only=True,sharing=False,live_style=True,following=True,processing_ms=1,first_update_ms=None,max_lag_ms=None)))
"#).unwrap();
        let _ = path;
        let inner = manager.inner.clone();
        let job = std::thread::spawn(move || run_local(&inner, "saved-call", true, true));
        let deadline = Instant::now() + Duration::from_secs(5);
        let output = loop {
            let found = std::fs::read_dir(&manager.inner.replay_root)
                .ok()
                .and_then(|rows| {
                    rows.filter_map(Result::ok)
                        .map(|r| r.path())
                        .find(|p| p.join("live-mode.json").exists())
                });
            if let Some(output) = found {
                break output;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        };
        manager.foreground(true);
        std::thread::sleep(Duration::from_millis(200));
        assert!(manager.inner.child.lock().unwrap().is_some());
        assert!(!manager.inner.interrupted.load(Ordering::Acquire));
        manager.foreground(false);
        std::fs::write(output.join("release"), "").unwrap();
        assert!(job.join().unwrap().unwrap().following);
        assert_eq!(
            std::fs::read_to_string(output.join("launches")).unwrap(),
            "1"
        );
        assert!(manager.inner.live_output.lock().unwrap().is_none());
    }

    #[test]
    fn streaming_worker_that_falls_back_to_whisper_during_dictation_is_stopped() {
        let (manager, _path) = fixture();
        let model = manager.inner.root.join("asr");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(model.join("config.json"), "{}").unwrap();
        write(
            &manager.inner.runtime,
            &Runtime {
                python: "/usr/bin/python3".into(),
                asr_model: model,
                summary_runtime: "unused".into(),
                summary_model: "unused".into(),
                stream_asr: None,
                stream_models: None,
            },
        )
        .unwrap();
        // First launch streams until told to fall back, then reports Whisper and keeps working;
        // the relaunch after dictation finishes.
        std::fs::write(&manager.inner.script,r#"import json,pathlib,sys,time
p=pathlib.Path(sys.argv[2]).parent
launches=p/'launches'
n=int(launches.read_text())+1 if launches.exists() else 1
launches.write_text(str(n))
if n==1:
    (p/'live-mode.json').write_text(json.dumps({'mode':'streaming'}))
    while not (p/'fall-back').exists(): time.sleep(.02)
    (p/'live-mode.json').write_text(json.dumps({'mode':'whisper'}))
    time.sleep(120)
(p/'local-feed-result.json').write_text(json.dumps(dict(complete=True,entries=0,feed_segments=0,feed_sequence=0,version=1,local_only=True,sharing=False,live_style=True,following=True,processing_ms=1,first_update_ms=None,max_lag_ms=None)))
"#).unwrap();
        let inner = manager.inner.clone();
        let job = std::thread::spawn(move || run_local(&inner, "saved-call", true, true));
        let deadline = Instant::now() + Duration::from_secs(5);
        let output = loop {
            let found = std::fs::read_dir(&manager.inner.replay_root)
                .ok()
                .and_then(|rows| {
                    rows.filter_map(Result::ok)
                        .map(|r| r.path())
                        .find(|p| p.join("live-mode.json").exists())
                });
            if let Some(output) = found {
                break output;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        };
        manager.foreground(true);
        std::thread::sleep(Duration::from_millis(200));
        assert!(manager.inner.child.lock().unwrap().is_some());
        std::fs::write(output.join("fall-back"), "").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !manager.inner.interrupted.load(Ordering::Acquire) {
            assert!(
                Instant::now() < deadline,
                "a Whisper worker must not run during dictation"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        manager.foreground(false);
        *manager.inner.quiet_until.lock().unwrap() = Instant::now();
        assert!(job.join().unwrap().unwrap().following);
        assert_eq!(
            std::fs::read_to_string(output.join("launches")).unwrap(),
            "2"
        );
    }

    #[test]
    fn growing_feed_resumes_same_exchange_after_dictation() {
        let (manager, path) = fixture();
        let model = manager.inner.root.join("asr");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(model.join("config.json"), "{}").unwrap();
        write(
            &manager.inner.runtime,
            &Runtime {
                python: "/usr/bin/python3".into(),
                asr_model: model,
                summary_runtime: "unused".into(),
                summary_model: "unused".into(),
                stream_asr: None,
                stream_models: None,
            },
        )
        .unwrap();
        std::fs::write(&manager.inner.script,r#"import json,pathlib,sys,time
p=pathlib.Path(sys.argv[2]).parent
marker=p/'first-attempt'
if not marker.exists():
    marker.write_text('started')
    time.sleep(120)
(p/'local-feed-result.json').write_text(json.dumps(dict(complete=True,entries=0,feed_segments=0,feed_sequence=0,version=1,local_only=True,sharing=False,live_style=True,following=True,processing_ms=1,first_update_ms=None,max_lag_ms=0)))
"#).unwrap();
        let before = std::fs::read(path.join("session.json")).unwrap();
        let inner = manager.inner.clone();
        let job = std::thread::spawn(move || run_local(&inner, "saved-call", true, true));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let started = std::fs::read_dir(&manager.inner.replay_root)
                .ok()
                .is_some_and(|rows| {
                    rows.filter_map(Result::ok)
                        .any(|r| r.path().join("first-attempt").exists())
                });
            if started {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        manager.foreground(true);
        std::thread::sleep(Duration::from_millis(200));
        assert!(manager.inner.child.lock().unwrap().is_none());
        manager.foreground(false);
        let settle = manager
            .inner
            .quiet_until
            .lock()
            .unwrap()
            .saturating_duration_since(Instant::now());
        assert!(settle >= Duration::from_millis(150) && settle <= Duration::from_millis(300));
        *manager.inner.quiet_until.lock().unwrap() = Instant::now();
        let result = job.join().unwrap().unwrap();
        assert!(result.following);
        let registry: serde_json::Value =
            read(&manager.inner.root.join("assistie-local/registry.json")).unwrap();
        assert_eq!(registry["sessions"].as_array().unwrap().len(), 1);
        assert!(manager.inner.child.lock().unwrap().is_none());
        assert!(manager.inner.queue.lock().unwrap().current.is_none());
        assert_eq!(std::fs::read(path.join("session.json")).unwrap(), before);
    }

    #[test]
    fn paced_local_replay_yields_its_worker_slot_to_dictation() {
        let (manager, path) = fixture();
        let model = manager.inner.root.join("asr");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(model.join("config.json"), "{}").unwrap();
        write(
            &manager.inner.runtime,
            &Runtime {
                python: "/usr/bin/python3".into(),
                asr_model: model,
                summary_runtime: "not-used".into(),
                summary_model: "not-used".into(),
                stream_asr: None,
                stream_models: None,
            },
        )
        .unwrap();
        std::fs::write(&manager.inner.script, "import time\ntime.sleep(120)\n").unwrap();
        let before = std::fs::read(path.join("session.json")).unwrap();
        let inner = manager.inner.clone();
        let replay = std::thread::spawn(move || replay_local(&inner, "saved-call", true));
        let deadline = Instant::now() + Duration::from_secs(5);
        while manager.inner.child.lock().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(manager.inner.child.lock().unwrap().is_some());
        let interrupted = Instant::now();
        manager.foreground(true);
        assert!(replay.join().unwrap().is_err());
        assert!(interrupted.elapsed() < Duration::from_secs(3));
        assert!(manager.inner.child.lock().unwrap().is_none());
        assert!(manager.inner.queue.lock().unwrap().current.is_none());
        assert_eq!(std::fs::read(path.join("session.json")).unwrap(), before);
        let registry: serde_json::Value =
            read(&manager.inner.root.join("assistie-local/registry.json")).unwrap();
        let state: serde_json::Value = read(
            &manager
                .inner
                .root
                .join("assistie-local")
                .join(registry["active"].as_str().unwrap())
                .join("state.json"),
        )
        .unwrap();
        assert!(state["ended"] == true && state["local_only"] == true && state["sharing"] == false);
    }

    #[test]
    fn local_replay_failure_cleans_slot_and_never_requires_summary_model() {
        let (manager, path) = fixture();
        let root = &manager.inner.root;
        let model = root.join("asr");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(model.join("config.json"), "{}").unwrap();
        write(
            &manager.inner.runtime,
            &Runtime {
                python: "/usr/bin/python3".into(),
                asr_model: model,
                summary_runtime: "not-used".into(),
                summary_model: "not-used".into(),
                stream_asr: None,
                stream_models: None,
            },
        )
        .unwrap();
        std::fs::write(&manager.inner.script, "raise SystemExit(5)\n").unwrap();
        let before = std::fs::read(path.join("session.json")).unwrap();
        assert!(replay_local(&manager.inner, "saved-call", true).is_err());
        assert!(manager.inner.child.lock().unwrap().is_none());
        assert!(manager.inner.queue.lock().unwrap().current.is_none());
        assert_eq!(std::fs::read(path.join("session.json")).unwrap(), before);
        let registry: serde_json::Value = read(&root.join("assistie-local/registry.json")).unwrap();
        let run = registry["active"].as_str().unwrap();
        let value = super::super::assistie::exchange_at(
            &root.join("assistie-local"),
            "snapshot",
            Some(run),
            serde_json::json!({}),
        )
        .unwrap();
        assert_eq!(value["local_only"], true);
        assert_eq!(value["status"], "disabled");
        assert!(super::super::assistie::exchange_at(
            &root.join("assistie-local"),
            "controls",
            Some(run),
            serde_json::json!({"sharing":true,"proactive":false})
        )
        .is_err());
    }

    #[test]
    #[ignore = "requires explicitly selected saved audio and the installed offline ASR runtime"]
    fn saved_call_to_local_feed_offline() {
        let source = PathBuf::from(
            std::env::var("HANDY_LOCAL_FEED_SOURCE").expect("Select saved call root"),
        )
        .canonicalize()
        .unwrap();
        let mut id = std::env::var("HANDY_LOCAL_FEED_CALL").expect("Select saved call ID");
        let output = PathBuf::from(
            std::env::var("HANDY_LOCAL_FEED_OUTPUT").expect("Select private output folder"),
        );
        std::fs::create_dir_all(&output).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&output, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let script = output.join("worker.py");
        std::fs::write(&script, include_str!("worker.py")).unwrap();
        let following = std::env::var("HANDY_LOCAL_FEED_GROWING").as_deref() == Ok("1");
        let (audio_root, producer) = if following {
            let root = output.join("calls");
            std::fs::create_dir_all(&root).unwrap();
            let producer = saved_audio_producer(&source.join(&id), &root);
            id = "growing-fixture".into();
            (root, Some(producer))
        } else {
            (source.clone(), None)
        };
        let manager = CallAiManager {
            inner: Arc::new(Inner {
                root: audio_root,
                replay_root: output.join("replays"),
                script,
                runtime: source.parent().unwrap().join("call-ai-runtime.json"),
                queue: Mutex::new(Queue::default()),
                child: Mutex::new(None),
                foreground: AtomicBool::new(false),
                quiet_until: Mutex::new(Instant::now()),
                interrupted: AtomicBool::new(false),
                shutdown: AtomicBool::new(false),
                follow_target: Mutex::new(None),
                live_worker: AtomicBool::new(false),
                live_output: Mutex::new(None),
                live_starting: AtomicBool::new(false),
            }),
        };
        let live_style = std::env::var("HANDY_LOCAL_FEED_LIVE_STYLE").as_deref() == Ok("1");
        let interrupter = if following
            && std::env::var("HANDY_LOCAL_FEED_INTERRUPT").as_deref() == Ok("1")
        {
            let controller = CallAiManager {
                inner: manager.inner.clone(),
            };
            let timing_path = output.join("interruption.json");
            Some(std::thread::spawn(move || {
                let at = std::env::var("HANDY_LOCAL_FEED_INTERRUPT_AT_MS")
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok())
                    .filter(|n| (8000..=20000).contains(n))
                    .unwrap_or(12000);
                std::thread::sleep(Duration::from_millis(at));
                let foreground_at = chrono::Utc::now().timestamp_millis();
                controller.foreground(true);
                std::thread::sleep(Duration::from_secs(1));
                controller.foreground(false);
                let released_at = chrono::Utc::now().timestamp_millis();
                if std::env::var("HANDY_LOCAL_FEED_LEGACY_DELAY").as_deref() == Ok("1") {
                    *controller.inner.quiet_until.lock().unwrap() =
                        Instant::now() + Duration::from_secs(5);
                }
                let settle = controller
                    .inner
                    .quiet_until
                    .lock()
                    .unwrap()
                    .saturating_duration_since(Instant::now())
                    .as_millis();
                write(&timing_path,&serde_json::json!({"foreground_epoch_ms":foreground_at,"released_epoch_ms":released_at,"settle_ms":settle})).unwrap();
                controller
            }))
        } else {
            None
        };
        let result = run_local(&manager.inner, &id, live_style, following)
            .expect("Offline local replay failed; inspect private progress metadata");
        if let Some(interrupter) = interrupter {
            interrupter.join().unwrap();
        }
        if let Some(producer) = producer {
            producer.join().unwrap();
        }
        let transcript: Transcript = read(
            &manager
                .inner
                .replay_root
                .join(&result.run_id)
                .join("transcript.json"),
        )
        .unwrap();
        let state: serde_json::Value = read(
            &output
                .join("assistie-local")
                .join(&result.run_id)
                .join("state.json"),
        )
        .unwrap();
        let entries = state["feed"]["segments"].as_array().unwrap();
        assert!(
            transcript.complete && entries.len() <= transcript.entries.len() && entries.len() <= 32,
            "Full transcript or bounded live window is invalid"
        );
        assert!(
            entries
                .iter()
                .all(|s| transcript.entries.iter().any(|entry| s["text"].as_str()
                    == Some(entry.text.as_str())
                    && s["start_ms"].as_u64() == Some(entry.start_ms)
                    && s["end_ms"].as_u64() == Some(entry.end_ms)
                    && s["source"]
                        == if entry.source == "mic" {
                            "you"
                        } else {
                            "other_audio"
                        })),
            "Final transcript/feed content mismatch"
        );
        assert!(
            serde_json::to_vec(
                &state["transcripts"].as_array().unwrap().last().unwrap()["sources"]
            )
            .unwrap()
            .len()
                <= 12000
        );
        if let Some(latest) = transcript.entries.iter().max_by_key(|entry| entry.start_ms) {
            assert!(
                entries
                    .iter()
                    .any(|s| s["text"] == latest.text && s["start_ms"] == latest.start_ms),
                "Recent window omitted the newest transcript entry"
            );
        }
        assert!(
            state["local_only"] == true
                && state["sharing"] == false
                && state["ended"] == true
                && state["worker_ready"] == false,
            "Local-only boundary failed"
        );
        assert!(state["delivered"].as_array().unwrap().is_empty());
        assert!(manager.inner.child.lock().unwrap().is_none());
        let registry: serde_json::Value =
            read(&output.join("assistie-local/registry.json")).unwrap();
        assert_eq!(registry["sessions"].as_array().unwrap().len(), 1);
        if live_style {
            let callbacks: Vec<serde_json::Value> = read(
                &manager
                    .inner
                    .replay_root
                    .join(&result.run_id)
                    .join("feed-updates.json"),
            )
            .unwrap();
            assert!(callbacks.len() > 2 && callbacks.iter().any(|e| e["complete"] == false));
            assert!(
                callbacks
                    .iter()
                    .all(|e| e["elapsed_ms"].as_u64().unwrap() + 20
                        >= e["audio_available_ms"].as_u64().unwrap()),
                "Replay released audio before its availability time"
            );
            assert!(
                callbacks
                    .windows(2)
                    .all(|pair| pair[0]["audio_available_ms"].as_u64()
                        <= pair[1]["audio_available_ms"].as_u64()),
                "Replay sources were not time ordered"
            );
            assert!(
                callbacks.iter().any(|e| e["segments"].as_u64().unwrap() > 0
                    && e["elapsed_ms"].as_u64().unwrap() < 30000),
                "No transcript arrived before the old chunk boundary"
            );
        }
        write(&output.join("verification-metadata.json"), &result).unwrap();
        println!("Local replay verified: entries={}, segments={}, batches={}, version={}, complete={}, sharing={}", result.entries,result.feed_segments,result.feed_sequence,result.version,result.complete,result.sharing);
    }

    fn saved_audio_producer(source: &Path, root: &Path) -> std::thread::JoinHandle<()> {
        use super::super::capture::Writer;
        let mut session: CallSession = read(&source.join("session.json")).unwrap();
        assert!(!session.active && session.mic_segments.len() == 1);
        let mut tracks = Vec::new();
        for name in ["system.wav", &session.mic_segments[0].file] {
            let mut wav = hound::WavReader::open(source.join(name)).unwrap();
            let rate = wav.spec().sample_rate;
            let samples = wav.samples::<f32>().map(Result::unwrap).collect::<Vec<_>>();
            tracks.push((name.to_owned(), rate, samples));
        }
        let target = root.join("growing-fixture");
        std::fs::create_dir(&target).unwrap();
        let mut writers = tracks
            .iter()
            .map(|(name, rate, _)| Writer::new(&target.join(name), *rate, None).unwrap())
            .collect::<Vec<_>>();
        session.id = "growing-fixture".into();
        session.active = true;
        session.notes.clear();
        session.title.clear();
        session.elapsed_ms = 0;
        session.system = writers[0].0.stats();
        session.mic_segments[0].stats = writers[1].0.stats();
        write(&target.join("session.json"), &session).unwrap();
        std::thread::spawn(move || {
            let started = Instant::now();
            let mut sent = [0, 0];
            while sent
                .iter()
                .zip(&tracks)
                .any(|(n, (_, _, samples))| *n < samples.len())
            {
                std::thread::sleep(Duration::from_millis(250));
                for (i, (_, rate, samples)) in tracks.iter().enumerate() {
                    let offset = if i == 0 {
                        0
                    } else {
                        session.mic_segments[0].offset_ms
                    };
                    let count = ((started.elapsed().as_millis() as u64).saturating_sub(offset)
                        as f64
                        / 1000.0
                        * *rate as f64) as usize;
                    let end = count.min(samples.len());
                    for value in &samples[sent[i]..end] {
                        writers[i].1.push(*value);
                    }
                    sent[i] = end;
                }
                session.elapsed_ms = started.elapsed().as_millis() as u64;
                session.system = writers[0].0.stats();
                session.mic_segments[0].stats = writers[1].0.stats();
                write(&target.join("session.json"), &session).unwrap();
            }
            session.system = writers[0].0.finish();
            session.mic_segments[0].stats = writers[1].0.finish();
            assert!(
                session.system.error.is_none() && session.mic_segments[0].stats.error.is_none()
            );
            session.active = false;
            write(&target.join("session.json"), &session).unwrap();
        })
    }
    fn fixture() -> (CallAiManager, PathBuf) {
        let data = tempfile::tempdir().unwrap().keep();
        let root = data.canonicalize().unwrap().join("calls");
        std::fs::create_dir(&root).unwrap();
        let path = root.join("saved-call");
        std::fs::create_dir(&path).unwrap();
        write(
            &path.join("session.json"),
            &CallSession {
                id: "saved-call".into(),
                notes: "Original notes".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let manager = CallAiManager {
            inner: Arc::new(Inner {
                root: root.clone(),
                replay_root: root.join("replays"),
                script: root.join("worker.py"),
                runtime: root.join("runtime.json"),
                queue: Mutex::new(Queue::default()),
                child: Mutex::new(None),
                foreground: AtomicBool::new(false),
                quiet_until: Mutex::new(Instant::now()),
                interrupted: AtomicBool::new(false),
                shutdown: AtomicBool::new(false),
                follow_target: Mutex::new(None),
                live_worker: AtomicBool::new(false),
                live_output: Mutex::new(None),
                live_starting: AtomicBool::new(false),
            }),
        };
        (manager, path)
    }
    #[test]
    fn rejects_path_escape_and_linked_calls() {
        use std::os::unix::fs::symlink;
        let (manager, path) = fixture();
        let root = &manager.inner.root;
        assert!(folder(root, "../saved-call").is_err());
        assert!(folder(root, "/tmp").is_err());
        symlink(&path, root.join("linked")).unwrap();
        assert!(folder(root, "linked").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    fn call_with_runs(manager: &CallAiManager, path: &Path) -> Vec<PathBuf> {
        let data = manager.inner.root.parent().unwrap().to_path_buf();
        let replay = manager.inner.replay_root.join("run-a");
        let feed = data.join("assistie-local/feed-a");
        let terra = data.join("assistie/meeting-a");
        let other = data.join("assistie/meeting-other");
        for folder in [&replay, &feed, &terra, &other] {
            std::fs::create_dir_all(folder).unwrap();
        }
        write(
            &replay.join("request.json"),
            &serde_json::json!({"session":{"id":"saved-call"},"feed":{"run_id":"feed-a"}}),
        )
        .unwrap();
        write(
            &terra.join("state.json"),
            &serde_json::json!({"call_binding":{"call_id":"saved-call"}}),
        )
        .unwrap();
        write(
            &other.join("state.json"),
            &serde_json::json!({"call_binding":{"call_id":"another"}}),
        )
        .unwrap();
        vec![replay, feed, terra, path.to_path_buf(), other]
    }
    #[test]
    fn deleting_a_call_moves_everything_it_left_and_nothing_else() {
        let (manager, path) = fixture();
        let parts = call_with_runs(&manager, &path);
        let trash = tempfile::tempdir().unwrap();
        trash_call(&manager.inner, trash.path(), "saved-call", None).unwrap();
        for part in &parts[..4] {
            assert!(!part.exists(), "{part:?} should have moved");
        }
        assert!(parts[4].exists(), "another call's run stays");
        let moved = std::fs::read_dir(trash.path().join("Voce call saved-call")).unwrap();
        assert_eq!(moved.count(), 4);
        assert!(list(&manager.inner.root).unwrap().is_empty());
    }
    #[test]
    fn deleting_the_latest_call_leaves_the_next_session_working() {
        let (manager, _path) = fixture();
        let store = manager.inner.root.parent().unwrap().join("assistie-local");
        super::super::assistie::prepare(&store).unwrap();
        let binding = serde_json::json!({"call_id":"saved-call","recording_key":"a".repeat(64)});
        let run = super::super::assistie::exchange_at(&store, "create_local", None, binding)
            .unwrap()["run_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let replay = manager.inner.replay_root.join("run-a");
        std::fs::create_dir_all(&replay).unwrap();
        write(
            &replay.join("request.json"),
            &serde_json::json!({"session":{"id":"saved-call"},"feed":{"run_id":run}}),
        )
        .unwrap();
        let registry: serde_json::Value = read(&store.join("registry.json")).unwrap();
        assert_eq!(
            registry["active"],
            run.as_str(),
            "the call's run starts active"
        );
        let trash = tempfile::tempdir().unwrap();
        trash_call(&manager.inner, trash.path(), "saved-call", None).unwrap();
        assert!(!store.join(&run).exists());
        let registry: serde_json::Value = read(&store.join("registry.json")).unwrap();
        assert!(registry["active"].is_null());
        let next = serde_json::json!({"call_id":"next-call","recording_key":"b".repeat(64)});
        super::super::assistie::exchange_at(&store, "create_local", None, next).unwrap();
    }
    #[test]
    fn only_a_starting_live_transcript_skips_the_quiet_period() {
        let (manager, _path) = fixture();
        manager.interrupt();
        assert!(live_held(&manager.inner));
        manager.follow("saved-call").unwrap();
        assert!(!live_held(&manager.inner), "the live transcript starts now");
        assert!(
            Instant::now() < *manager.inner.quiet_until.lock().unwrap(),
            "background jobs still wait"
        );
        manager.foreground(true);
        assert!(live_held(&manager.inner), "dictation still comes first");
        manager.foreground(false);
        assert!(live_held(&manager.inner), "and so does its settling time");
    }
    #[test]
    fn a_failed_delete_puts_everything_back() {
        let (manager, path) = fixture();
        let parts = call_with_runs(&manager, &path);
        let store = manager.inner.root.parent().unwrap().join("assistie");
        std::fs::write(store.join("registry.json"), "not a registry").unwrap();
        let trash = tempfile::tempdir().unwrap();
        manager.enqueue("saved-call").unwrap();
        assert!(trash_call(&manager.inner, trash.path(), "saved-call", None).is_err());
        for part in &parts {
            assert!(part.exists(), "{part:?} should be back");
        }
        assert_eq!(manager.inner.queue.lock().unwrap().ids.len(), 1);
    }
    #[test]
    fn a_call_that_just_ended_waits_for_its_writers() {
        let (manager, path) = fixture();
        let mut session: CallSession = read(&path.join("session.json")).unwrap();
        session.started_at = chrono::Utc::now().to_rfc3339();
        write(&path.join("session.json"), &session).unwrap();
        let trash = tempfile::tempdir().unwrap();
        assert!(trash_call(&manager.inner, trash.path(), "saved-call", None).is_err());
        assert!(path.exists());
    }
    #[test]
    fn a_call_in_use_cannot_be_deleted() {
        let (manager, path) = fixture();
        let trash = tempfile::tempdir().unwrap();
        assert!(trash_call(
            &manager.inner,
            trash.path(),
            "saved-call",
            Some("saved-call")
        )
        .is_err());
        manager.inner.queue.lock().unwrap().current = Some("saved-call".into());
        assert!(trash_call(&manager.inner, trash.path(), "saved-call", None).is_err());
        manager.inner.queue.lock().unwrap().current = None;
        let mut session: CallSession = read(&path.join("session.json")).unwrap();
        session.active = true;
        write(&path.join("session.json"), &session).unwrap();
        assert!(trash_call(&manager.inner, trash.path(), "saved-call", None).is_err());
        assert!(path.exists());
    }
    #[test]
    fn deleting_a_queued_call_drops_its_job() {
        let (manager, _path) = fixture();
        manager.enqueue("saved-call").unwrap();
        let trash = tempfile::tempdir().unwrap();
        trash_call(&manager.inner, trash.path(), "saved-call", None).unwrap();
        assert!(manager.inner.queue.lock().unwrap().ids.is_empty());
    }
    #[test]
    fn a_generated_title_names_an_untitled_call_only() {
        let (manager, path) = fixture();
        let root = path.parent().unwrap();
        write(
            &path.join("title.json"),
            &serde_json::json!({"title":"board game night"}),
        )
        .unwrap();
        let mut session: CallSession = read(&path.join("session.json")).unwrap();
        session.title = DEFAULT_TITLE.into();
        write(&path.join("session.json"), &session).unwrap();
        assert_eq!(list(root).unwrap()[0].title, "board game night");
        session.title = "My own name".into();
        write(&path.join("session.json"), &session).unwrap();
        assert_eq!(list(root).unwrap()[0].title, "My own name");
        drop(manager);
    }
    #[test]
    fn notes_cancel_stale_work_without_losing_previous_summary() {
        let (manager, path) = fixture();
        manager.enqueue("saved-call").unwrap();
        let job: Job = read(&path.join("analysis.json")).unwrap();
        let summary = Summary {
            job_id: "old".into(),
            recording_key: job.recording_key.clone(),
            notes_key: job.notes_key.clone(),
            transcript_version: "v1".into(),
            sections: Sections::default(),
            edited_text: Some("My edited summary".into()),
        };
        write(&path.join("summary.json"), &summary).unwrap();
        manager
            .save_notes("saved-call", "New notes".into())
            .unwrap();
        finish(&manager.inner, &path, job, true).unwrap();
        assert_eq!(
            read::<Job>(&path.join("analysis.json")).unwrap().status,
            "outdated"
        );
        assert_eq!(
            read::<Summary>(&path.join("summary.json"))
                .unwrap()
                .edited_text,
            summary.edited_text
        );
        assert!(manager
            .save_summary("saved-call", "wrong-job", "Lost edit".into())
            .is_err());
        manager.enqueue("saved-call").unwrap();
        manager.cancel("saved-call").unwrap();
        assert_eq!(
            read::<Job>(&path.join("analysis.json")).unwrap().status,
            "cancelled"
        );
        assert_eq!(
            read::<CallSession>(&path.join("session.json"))
                .unwrap()
                .notes,
            "New notes"
        );
        std::fs::remove_dir_all(&manager.inner.root).unwrap();
    }
    #[test]
    fn failed_summary_keeps_transcript_and_previous_edit() {
        let (manager, path) = fixture();
        manager.enqueue("saved-call").unwrap();
        let job: Job = read(&path.join("analysis.json")).unwrap();
        let transcript = Transcript {
            complete: true,
            version: "v1".into(),
            recording_key: job.recording_key.clone(),
            ..Default::default()
        };
        write(&path.join("transcript.json"), &transcript).unwrap();
        finish(&manager.inner, &path, job, false).unwrap();
        assert_eq!(manager.view("saved-call").unwrap().status, "failed");
        assert!(
            read::<Transcript>(&path.join("transcript.json"))
                .unwrap()
                .complete
        );
        std::fs::remove_dir_all(&manager.inner.root).unwrap();
    }
    #[test]
    fn foreground_kills_worker_group_and_requeues_from_checkpoint() {
        use std::os::unix::process::CommandExt;
        let (manager, path) = fixture();
        manager.enqueue("saved-call").unwrap();
        let job: Job = read(&path.join("analysis.json")).unwrap();
        let child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        *manager.inner.child.lock().unwrap() = Some(child);
        let at = Instant::now();
        manager.foreground(true);
        let mut child = manager.inner.child.lock().unwrap().take().unwrap();
        assert!(!child.wait().unwrap().success());
        assert!(at.elapsed() < Duration::from_secs(1));
        finish(&manager.inner, &path, job, false).unwrap();
        assert_eq!(manager.view("saved-call").unwrap().status, "paused");
        manager.foreground(false);
        assert!(!manager.inner.foreground.load(Ordering::Acquire));
        assert!(*manager.inner.quiet_until.lock().unwrap() > Instant::now());
        std::fs::remove_dir_all(&manager.inner.root).unwrap();
    }
}

#[cfg(test)]
mod local_model_test {
    use super::*;
    // Uses only an explicitly supplied synthetic WAV fixture and installed models.
    #[test]
    #[ignore = "requires HANDY_CALL_AI_FIXTURE and HANDY_CALL_AI_RUNTIME"]
    fn summary_process_group_pauses_and_resumes_without_a_microphone() {
        let source =
            PathBuf::from(std::env::var_os("HANDY_CALL_AI_FIXTURE").expect("synthetic fixture"));
        let config =
            PathBuf::from(std::env::var_os("HANDY_CALL_AI_RUNTIME").expect("local runtime config"));
        let root = std::env::temp_dir().join(format!(
            "handy-local-model-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let path = root.join("sample");
        std::fs::create_dir(&path).unwrap();
        for file in ["system.wav", "mic-0.wav", "session.json"] {
            std::fs::copy(source.join(file), path.join(file)).unwrap();
        }
        let mut session: CallSession = read(&path.join("session.json")).unwrap();
        session.id = "sample".into();
        write(&path.join("session.json"), &session).unwrap();
        let script = root.join("worker.py");
        std::fs::write(&script, include_str!("worker.py")).unwrap();
        let manager = CallAiManager {
            inner: Arc::new(Inner {
                root: root.clone(),
                replay_root: root.join("replays"),
                script,
                runtime: config,
                queue: Mutex::new(Queue::default()),
                child: Mutex::new(None),
                foreground: AtomicBool::new(false),
                quiet_until: Mutex::new(Instant::now()),
                interrupted: AtomicBool::new(false),
                shutdown: AtomicBool::new(false),
                follow_target: Mutex::new(None),
                live_worker: AtomicBool::new(false),
                live_output: Mutex::new(None),
                live_starting: AtomicBool::new(false),
            }),
        };
        manager.enqueue("sample").unwrap();
        let mut job: Job = read(&path.join("analysis.json")).unwrap();
        job.status = "running".into();
        write(&path.join("analysis.json"), &job).unwrap();
        let inner = manager.inner.clone();
        let working_path = path.clone();
        let working_job = job.clone();
        let attempt = std::thread::spawn(move || execute(&inner, &working_path, &working_job));
        let at = Instant::now();
        let mut runtime_pid = None;
        while at.elapsed() < Duration::from_secs(90) {
            let worker_pid = manager.inner.child.lock().unwrap().as_ref().map(|c| c.id());
            if let Some(pid) = worker_pid {
                let result = Command::new("pgrep")
                    .args(["-P", &pid.to_string()])
                    .output()
                    .unwrap();
                runtime_pid = String::from_utf8_lossy(&result.stdout)
                    .lines()
                    .filter_map(|s| s.trim().parse::<i32>().ok())
                    .find(|pid| {
                        Command::new("ps")
                            .args(["-p", &pid.to_string(), "-o", "comm="])
                            .output()
                            .is_ok_and(|value| {
                                String::from_utf8_lossy(&value.stdout)
                                    .trim()
                                    .ends_with("/llama-server")
                            })
                    });
                let drafting =
                    optional::<Progress>(&path.join(format!("progress-{}.json", job.job_id)))
                        .ok()
                        .flatten()
                        .is_some_and(|p| p.status == "summarizing");
                if drafting && runtime_pid.is_some() {
                    break;
                }
                runtime_pid = None;
            }
            assert!(
                !attempt.is_finished(),
                "worker ended before runtime preemption test"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        let runtime_pid = runtime_pid.expect("summary runtime child started");
        let before = read::<Transcript>(&path.join("transcript.json")).unwrap();
        assert!(before.complete);
        let interrupted_at = Instant::now();
        manager.foreground(true);
        attempt.join().unwrap().unwrap();
        let kill_latency = interrupted_at.elapsed();
        assert!(kill_latency < Duration::from_secs(2));
        assert_eq!(manager.view("sample").unwrap().status, "paused");
        for _ in 0..20 {
            if unsafe { kill(runtime_pid, 0) } != 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_ne!(
            unsafe { kill(runtime_pid, 0) },
            0,
            "summary child must not survive worker cancellation"
        );
        manager.foreground(false);
        *manager.inner.quiet_until.lock().unwrap() = Instant::now();
        job.status = "running".into();
        write(&path.join("analysis.json"), &job).unwrap();
        execute(&manager.inner, &path, &job).unwrap();
        let view = manager.view("sample").unwrap();
        assert_eq!(view.status, "ready");
        assert_eq!(view.transcript.unwrap().version, before.version);
        assert!(view.summary.is_some());
        println!(
            "Actual Whisper + Qwen interruption and resume passed; kill latency {:?}",
            kill_latency
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
