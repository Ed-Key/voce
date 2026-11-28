//! Voce cleanup: the s1-mini model file and the llama-server sidecar that runs
//! it on 127.0.0.1 (onboarding table rows 11 and 12).
//!
//! The server starts on demand (the first cleanup or a test), is health-checked
//! before use, stops after `model_unload_timeout` of idle time, is started
//! again on the next use after a crash (a start that fails twice in a row gives
//! up until a test retries), and is killed on app exit. A pid file lets the
//! next launch kill a server left behind by a crash of Voce itself.
//!
//! The binary is the Tauri externalBin next to Voce's executable; development
//! and tests point `VOCE_LLAMA_SERVER` at a copy instead.

use crate::managers::model::{HttpDownloadOutcome, ModelManager};
use hf_hub::api::tokio::CancellationToken;
use log::{info, warn};
use serde::Serialize;
use specta::Type;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// `model_id` of this download's `model-download-progress` events.
pub const MODEL_PROGRESS_ID: &str = "voce-cleanup-s1-mini";
pub const MODEL_FILE: &str = "s1-mini-q4_k_m.gguf";
/// superwhisper/s1-mini-GGUF pinned to a commit; Apache 2.0, credited in the
/// UI as "S1-mini by Superwhisper".
const MODEL_URL: &str = "https://huggingface.co/superwhisper/s1-mini-GGUF/resolve/34add00a48a2e5d24e5a4ee5405a99620a3a240c/s1-mini-q4_k_m.gguf";
pub const MODEL_BYTES: u64 = 484_219_808;
const MODEL_SHA256: &str = "3b41ebe2502cbd03e811d5d16b022f5ab551eda58d62597d152f89535003c634";

/// How long a starting server may take to answer /health.
const START_TIMEOUT: Duration = Duration::from_secs(20);
const REAP_EVERY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum StartError {
    /// The model file is not downloaded yet.
    DownloadNeeded,
    /// No runtime binary, it exited, or it never became healthy.
    StartFailed,
}

pub fn model_path(models_dir: &Path) -> PathBuf {
    models_dir.join(MODEL_FILE)
}

fn partial_path(models_dir: &Path) -> PathBuf {
    models_dir.join(format!("{MODEL_FILE}.partial"))
}

/// The llama-server to run: `VOCE_LLAMA_SERVER`, else the sidecar Tauri
/// bundles next to Voce's executable.
pub fn server_binary() -> Option<PathBuf> {
    let path = match std::env::var_os("VOCE_LLAMA_SERVER").filter(|v| !v.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => std::env::current_exe().ok()?.parent()?.join("llama-server"),
    };
    path.is_file().then_some(path)
}

/// The flags that made llama-server match LM Studio on all 126 cases of the
/// cleanup eval, `--repeat-penalty 1.1` included.
fn server_args(model: &Path, port: u16) -> Vec<String> {
    [
        "-m",
        &model.to_string_lossy(),
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "-c",
        "4096",
        "-ngl",
        "99",
        "--jinja",
        "--temp",
        "0",
        "--repeat-penalty",
        "1.1",
        "--chat-template-kwargs",
        r#"{"enable_thinking":false}"#,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
}

#[derive(Default)]
struct State {
    child: Option<Child>,
    port: u16,
    last_used: Option<Instant>,
    idle_after: Option<Duration>,
    in_use: usize,
    /// Two starts in a row failed: fail at once until a forced start.
    gave_up: bool,
    /// A start is under way (spawn to lease): the reaper leaves it alone.
    starting: bool,
    /// The app is quitting: nothing may start again.
    shut_down: bool,
    /// Storage is removing the model: nothing may start or lease.
    removing: bool,
    /// The user chose something else: retire the server once no request
    /// holds it. Cleared by a start someone asked for (warm-up, test)
    /// after the cancellation, never by one issued before it.
    unwanted: bool,
    /// Bumped by every cancellation (`release_unwanted`).
    cancel_gen: u64,
}

pub struct Sidecar {
    binary: Option<PathBuf>,
    model: PathBuf,
    /// `<data>/runtime`: the pid file and the server's stderr log.
    runtime_dir: Option<PathBuf>,
    state: Mutex<State>,
    /// One start at a time.
    start_lock: tokio::sync::Mutex<()>,
}

/// While held, the idle reaper leaves the server alone.
pub struct Lease<'a> {
    sidecar: &'a Sidecar,
    pub base_url: String,
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let mut state = self.sidecar.lock();
        state.in_use = state.in_use.saturating_sub(1);
        state.last_used = Some(Instant::now());
        if state.unwanted && state.in_use == 0 && !state.starting {
            info!("Cleanup server no longer wanted; stopping it");
            self.sidecar.retire(&mut state);
        }
    }
}

/// A start under way. Dropped without `finish` (the caller's future was
/// cancelled, or the start failed), it clears `starting` and retires the
/// half-started server, so nothing stays marked busy or loads unowned.
struct Starting<'a> {
    sidecar: &'a Sidecar,
    done: bool,
}

impl Drop for Starting<'_> {
    fn drop(&mut self) {
        let mut state = self.sidecar.lock();
        state.starting = false;
        if !self.done {
            self.sidecar.retire(&mut state);
        }
    }
}

/// Storage holds this while it deletes the model; acquisitions fail until
/// it is dropped.
pub struct Removal<'a> {
    sidecar: &'a Sidecar,
}

impl Drop for Removal<'_> {
    fn drop(&mut self) {
        self.sidecar.lock().removing = false;
    }
}

impl Sidecar {
    pub fn new(binary: Option<PathBuf>, model: PathBuf, runtime_dir: Option<PathBuf>) -> Self {
        Sidecar {
            binary,
            model,
            runtime_dir,
            state: Mutex::new(State::default()),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn pid_file(&self) -> Option<PathBuf> {
        self.runtime_dir
            .as_ref()
            .map(|d| d.join("cleanup-server.pid"))
    }

    /// A request holds the server, or a start is under way.
    pub fn in_use(&self) -> bool {
        let state = self.lock();
        state.in_use > 0 || state.starting
    }

    /// The running server's URL, if it is up.
    pub fn running_url(&self) -> Option<String> {
        let mut state = self.lock();
        self.alive(&mut state).then(|| base_url(state.port))
    }

    /// A healthy server, started if needed. `force` retries after a give-up
    /// (the onboarding test and its Retry).
    pub async fn ensure(
        &self,
        idle_after: Option<Duration>,
        force: bool,
    ) -> Result<Lease<'_>, StartError> {
        self.ensure_while(idle_after, force, &|| true).await
    }

    /// Start the server ahead of use while `wanted()` holds: checked after
    /// waiting for another start and before every spawn, so a warm-up the
    /// user no longer wants never starts one.
    pub async fn warm(
        &self,
        idle_after: Option<Duration>,
        wanted: &(dyn Fn() -> bool + Sync),
    ) -> Result<(), StartError> {
        self.ensure_while(idle_after, true, wanted).await.map(drop)
    }

    async fn ensure_while(
        &self,
        idle_after: Option<Duration>,
        force: bool,
        wanted: &(dyn Fn() -> bool + Sync),
    ) -> Result<Lease<'_>, StartError> {
        if !self.model.is_file() {
            return Err(StartError::DownloadNeeded);
        }
        let issued = self.lock().cancel_gen;
        let _one_start = self.start_lock.lock().await;
        // A test or warm-up queued before the user cancelled is abandoned.
        let stale = |state: &State| force && state.cancel_gen != issued;
        let mut starting = {
            let mut state = self.lock();
            state.idle_after = idle_after;
            if stale(&state) {
                return Err(StartError::StartFailed);
            }
            if force && wanted() {
                state.unwanted = false;
            }
            if state.removing {
                return Err(StartError::DownloadNeeded);
            }
            if state.shut_down {
                return Err(StartError::StartFailed);
            }
            if self.alive(&mut state) {
                return Ok(self.lease(&mut state));
            }
            if state.gave_up && !force {
                return Err(StartError::StartFailed);
            }
            if !wanted() {
                return Err(StartError::StartFailed);
            }
            state.starting = true;
            Starting {
                sidecar: self,
                done: false,
            }
        };
        // A crashed or never-started server gets one more try if the first
        // fails; a quit in between stops both.
        let mut started = false;
        let mut failures = 0;
        for attempt in 1..=2 {
            {
                let state = self.lock();
                if state.shut_down || stale(&state) || !wanted() {
                    break;
                }
            }
            match self.start().await {
                Ok(()) => {
                    started = true;
                    break;
                }
                Err(e) => {
                    failures += 1;
                    warn!("Cleanup server start {attempt} failed: {e}");
                }
            }
        }
        let mut state = self.lock();
        if started && !state.removing && !stale(&state) && self.alive(&mut state) {
            starting.done = true;
            state.starting = false;
            state.gave_up = false;
            let lease = self.lease(&mut state);
            drop(state);
            drop(starting);
            Ok(lease)
        } else {
            // Only two real start failures give up; a quit, a cancellation
            // or a warm-up nobody wants any more never blocks later starts.
            if failures == 2 && !state.shut_down && !stale(&state) {
                state.gave_up = true;
            }
            drop(state);
            drop(starting);
            Err(StartError::StartFailed)
        }
    }

    fn lease(&self, state: &mut State) -> Lease<'_> {
        state.in_use += 1;
        state.last_used = Some(Instant::now());
        Lease {
            sidecar: self,
            base_url: base_url(state.port),
        }
    }

    async fn start(&self) -> Result<(), String> {
        self.stop();
        let binary = self.binary.as_ref().ok_or("no llama-server runtime")?;
        let port = free_port().map_err(|e| format!("no free port: {e}"))?;
        let stderr = self
            .runtime_dir
            .as_ref()
            .and_then(|d| {
                std::fs::create_dir_all(d).ok()?;
                std::fs::File::create(d.join("cleanup-server.log")).ok()
            })
            .map(Stdio::from)
            .unwrap_or_else(Stdio::null);
        {
            // Spawned under the lock, so a quit or a removal either comes
            // first (and nothing starts) or finds the child and kills it.
            let mut state = self.lock();
            if state.shut_down || state.removing {
                return Err("quitting or removing".into());
            }
            let child = Command::new(binary)
                .args(server_args(&self.model, port))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(stderr)
                .spawn()
                .map_err(|e| format!("spawn failed: {e}"))?;
            if let Some(pid_file) = self.pid_file() {
                // Without a start time the next launch never kills it.
                let record = match process_start_us(child.id()) {
                    Some(start) => format!("{}\n{start}", child.id()),
                    None => child.id().to_string(),
                };
                let _ = std::fs::write(pid_file, record);
            }
            state.child = Some(child);
            state.port = port;
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()
            .map_err(|e| e.to_string())?;
        let started = Instant::now();
        while started.elapsed() < START_TIMEOUT {
            if !self.running() {
                return Err("the server exited while starting".into());
            }
            // 503 while the model loads, 200 once it can answer.
            if let Ok(r) = client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send()
                .await
            {
                if r.status().is_success() {
                    info!("Cleanup server ready in {:?}", started.elapsed());
                    return Ok(());
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.stop();
        Err("the server never became healthy".into())
    }

    fn running(&self) -> bool {
        let mut state = self.lock();
        self.alive(&mut state)
    }

    /// Kill the server held in `state`, if any, and remove the pid file
    /// only when it names that server. Always called under the state lock,
    /// so a replacement cannot be spawned (and its pid file written) while
    /// an old server is being retired.
    fn retire(&self, state: &mut State) {
        if let Some(mut child) = state.child.take() {
            let _ = child.kill();
            let _ = child.wait();
            self.forget_pid(child.id());
            info!("Cleanup server stopped");
        }
    }

    fn forget_pid(&self, pid: u32) {
        let Some(pid_file) = self.pid_file() else {
            return;
        };
        let ours = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|s| recorded_pid(&s))
            == Some(pid);
        if ours {
            let _ = std::fs::remove_file(pid_file);
        }
    }

    /// Kill the server, if any.
    pub fn stop(&self) {
        let mut state = self.lock();
        self.retire(&mut state);
    }

    /// App exit: kill the server and let nothing start again, including a
    /// start already under way.
    pub fn shut_down(&self) {
        let mut state = self.lock();
        state.shut_down = true;
        self.retire(&mut state);
    }

    /// Nobody wants the server any more (the user chose something else):
    /// retire it now when idle, or when the last request lets go. Never
    /// touches a server a request holds.
    pub fn release_unwanted(&self) {
        let mut state = self.lock();
        state.unwanted = true;
        state.cancel_gen += 1;
        if state.in_use == 0 && !state.starting {
            self.retire(&mut state);
        }
    }

    /// Storage wants to delete the model: refused while a request holds
    /// the server or a start is under way; otherwise the server stops and
    /// nothing starts or leases until the returned guard is dropped.
    pub fn reserve_removal(&self) -> Result<Removal<'_>, String> {
        let mut state = self.lock();
        if state.in_use > 0 || state.starting {
            return Err("the cleanup model is in use".into());
        }
        state.removing = true;
        self.retire(&mut state);
        Ok(Removal { sidecar: self })
    }

    /// Stop the server once it has been idle for its timeout.
    fn reap_if_idle(&self) {
        // Decided and done under one lock: a lease or a start that comes
        // in between can never lose its server.
        let mut state = self.lock();
        let idle = self.alive(&mut state)
            && state.in_use == 0
            && !state.starting
            && match (state.idle_after, state.last_used) {
                (Some(after), Some(at)) => at.elapsed() >= after,
                _ => false,
            };
        if idle {
            info!("Cleanup server idle; stopping it");
            self.retire(&mut state);
        }
    }

    /// A server a crashed Voce left running holds RAM until killed. It is
    /// killed only when the process at the recorded pid has the recorded
    /// start time and runs Voce's model (`-m <its path in Voce's data
    /// folder>`): after a crash the pid can belong to any process by now,
    /// another app's llama-server included. A pid file without a start time
    /// (an older build's) is dropped and nothing is killed.
    fn kill_leftover(&self) {
        let Some(pid_file) = self.pid_file() else {
            return;
        };
        let Ok(record) = std::fs::read_to_string(&pid_file) else {
            return;
        };
        let start = record
            .split_once('\n')
            .and_then(|(_, start)| start.trim().parse::<u64>().ok());
        let model = format!("-m {}", self.model.to_string_lossy());
        let leftover = recorded_pid(&record).filter(|&pid| {
            start.is_some_and(|s| process_start_us(pid) == Some(s))
                && ps_field(pid, "command=").is_some_and(|c| c.contains(&model))
        });
        if let Some(pid) = leftover {
            warn!("Killing a cleanup server left from an earlier run");
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
        let _ = std::fs::remove_file(pid_file);
    }

    fn alive(&self, state: &mut State) -> bool {
        match state.child.as_mut().map(|c| c.try_wait()) {
            Some(Ok(None)) => true,
            Some(_) => {
                // Exited on its own (crashed): forget it; the next use starts one.
                if let Some(child) = state.child.take() {
                    warn!("Cleanup server exited on its own");
                    self.forget_pid(child.id());
                }
                false
            }
            None => false,
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1")
}

static SIDECAR: OnceLock<Sidecar> = OnceLock::new();
/// `<data>/cleanup`: the cleanup model, apart from the speech models
/// folder that speech discovery scans.
static MODELS_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn cleanup_dir(data: &Path) -> PathBuf {
    data.join("cleanup")
}

/// Builds before review 3 kept the model in `<data>/models`, where speech
/// discovery listed it. Move it (and a partial download) into its own
/// folder.
pub(crate) fn migrate_model(old_dir: &Path, new_dir: &Path) {
    migrate_model_checked(old_dir, new_dir, MODEL_BYTES, MODEL_SHA256);
}

/// A complete model counts only when it passes the download's own size and
/// sha256 check: a valid copy wins, an invalid one is removed (so status
/// never reports it as downloaded). Of two partials the larger (more
/// progress) is kept. The old copy goes only once the new place holds the
/// better file.
fn migrate_model_checked(old_dir: &Path, new_dir: &Path, size: u64, sha256: &str) {
    let valid = |p: &Path| file_matches(p, size, sha256);
    let (old, new) = (model_path(old_dir), model_path(new_dir));
    if old.exists() {
        if valid(&new) {
            let _ = std::fs::remove_file(&old);
        } else if valid(&old) {
            let _ = std::fs::remove_file(&new);
            move_into(&old, &new, new_dir);
        } else {
            let _ = std::fs::remove_file(&old);
        }
    }
    if new.exists() && !valid(&new) {
        warn!("Removing a cleanup model that fails its check");
        let _ = std::fs::remove_file(&new);
    }
    let (old, new) = (partial_path(old_dir), partial_path(new_dir));
    if old.exists() {
        let len = |p: &Path| p.metadata().map(|m| m.len()).unwrap_or(0);
        if new.exists() && len(&new) >= len(&old) {
            let _ = std::fs::remove_file(&old);
        } else {
            let _ = std::fs::remove_file(&new);
            move_into(&old, &new, new_dir);
        }
    }
}

fn move_into(from: &Path, to: &Path, dir: &Path) {
    if std::fs::create_dir_all(dir).is_ok() && std::fs::rename(from, to).is_ok() {
        info!("Moved the cleanup model out of the speech models folder");
    } else {
        warn!("Could not move the cleanup model out of the speech models folder");
    }
}

fn file_matches(path: &Path, size: u64, sha256: &str) -> bool {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    if path.metadata().map(|m| m.len()).ok() != Some(size) {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hasher.finalize()) == sha256
}
/// The pid on the first line of the pid file.
fn recorded_pid(record: &str) -> Option<u32> {
    record.lines().next()?.trim().parse().ok()
}

/// When a process started, in microseconds since the epoch, as the kernel
/// keeps it (the field `ps lstart` formats). A number tells a process from
/// a later one with the same pid, and unlike `ps`'s localized date string it
/// reads the same after a time-zone or locale change.
#[cfg(target_os = "macos")]
fn process_start_us(pid: u32) -> Option<u64> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is a zeroed proc_bsdinfo of exactly `size` bytes.
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut libc::proc_bsdinfo as *mut libc::c_void,
            size,
        )
    };
    (n == size).then(|| info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

/// No start time elsewhere, so a leftover is never killed there.
#[cfg(not(target_os = "macos"))]
fn process_start_us(_pid: u32) -> Option<u64> {
    None
}

/// One `ps` field of a running process (`command=`).
fn ps_field(pid: u32, field: &str) -> Option<String> {
    let out = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", field])
        .output()
        .ok()?;
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !value.is_empty()).then_some(value)
}

static DOWNLOAD: Mutex<Option<CancellationToken>> = Mutex::new(None);

/// The running s1-mini download's claim on `DOWNLOAD`, released when it
/// drops, so every exit (an error, a cancel, a dropped command) frees the
/// slot and Retry never reads "already downloading" for a finished attempt.
struct DownloadSlot(CancellationToken);

impl Drop for DownloadSlot {
    fn drop(&mut self) {
        DOWNLOAD.lock().unwrap_or_else(|p| p.into_inner()).take();
    }
}

/// Prepare the folder, then claim the slot: a preparation that fails
/// claims nothing.
fn begin_download(dir: &Path) -> Result<DownloadSlot, String> {
    let mut slot = DOWNLOAD.lock().unwrap_or_else(|p| p.into_inner());
    if slot.is_some() {
        return Err("already downloading".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let token = CancellationToken::new();
    *slot = Some(token.clone());
    Ok(DownloadSlot(token))
}

/// Startup: remember the folders, kill a leftover server, start the reaper.
pub fn init(app: &tauri::AppHandle) {
    let Ok(data) = crate::portable::app_data_dir(app) else {
        return;
    };
    let models = cleanup_dir(&data);
    migrate_model(&data.join("models"), &models);
    if MODELS_DIR.set(models.clone()).is_err() {
        return; // already initialized
    }
    let sidecar = SIDECAR.get_or_init(|| {
        Sidecar::new(
            server_binary(),
            model_path(&models),
            Some(data.join("runtime")),
        )
    });
    sidecar.kill_leftover();
    let _ = std::thread::Builder::new()
        .name("cleanup-server-reaper".into())
        .spawn(|| loop {
            std::thread::sleep(REAP_EVERY);
            if let Some(sidecar) = SIDECAR.get() {
                sidecar.reap_if_idle();
            }
        });
}

/// Tests that drive dictation's code paths against a real server.
#[cfg(test)]
pub fn install_for_test(sidecar: Sidecar) -> &'static Sidecar {
    SIDECAR.get_or_init(|| sidecar)
}

pub fn sidecar() -> Option<&'static Sidecar> {
    SIDECAR.get()
}

pub fn models_dir() -> Option<&'static PathBuf> {
    MODELS_DIR.get()
}

/// App exit (and the end of a headless run): nothing starts after this.
pub fn shutdown() {
    if let Some(sidecar) = SIDECAR.get() {
        sidecar.shut_down();
    }
}

pub fn idle_after(timeout: crate::settings::ModelUnloadTimeout) -> Option<Duration> {
    timeout.to_seconds().map(Duration::from_secs)
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct VoceCleanupStatus {
    pub downloaded: bool,
    pub downloading: bool,
    /// Bytes of a stopped download kept for resume.
    pub partial_bytes: u64,
    pub total_bytes: u64,
    /// A llama-server runtime was found.
    pub runtime_found: bool,
}

#[tauri::command]
#[specta::specta]
pub fn voce_cleanup_status() -> VoceCleanupStatus {
    let dir = models_dir();
    VoceCleanupStatus {
        downloaded: dir.is_some_and(|d| model_path(d).is_file()),
        downloading: DOWNLOAD.lock().unwrap_or_else(|p| p.into_inner()).is_some(),
        partial_bytes: dir
            .and_then(|d| partial_path(d).metadata().ok())
            .map(|m| m.len())
            .unwrap_or(0),
        total_bytes: MODEL_BYTES,
        runtime_found: sidecar().is_some_and(|s| s.binary.is_some()),
    }
}

/// Download s1-mini into Voce's models folder, resuming a stopped download
/// (progress as `model-download-progress` with `model_id`
/// `voce-cleanup-s1-mini`). Ok(false) when cancelled; the partial file stays.
#[tauri::command]
#[specta::specta]
pub async fn download_voce_cleanup_model(app: tauri::AppHandle) -> Result<bool, String> {
    let dir = models_dir().ok_or("no models folder")?.clone();
    if model_path(&dir).is_file() {
        start_warm(app);
        return Ok(true);
    }
    let slot = begin_download(&dir)?;
    let result = ModelManager::download_url_resumable(
        &app,
        MODEL_PROGRESS_ID,
        MODEL_URL,
        &partial_path(&dir),
        Some(MODEL_BYTES),
        Some(MODEL_SHA256),
        &slot.0,
    )
    .await;
    drop(slot);
    match result.map_err(|e| e.to_string())? {
        HttpDownloadOutcome::Cancelled => Ok(false),
        HttpDownloadOutcome::Completed => {
            std::fs::rename(partial_path(&dir), model_path(&dir)).map_err(|e| e.to_string())?;
            // Verified: start the server now, while the user reads the
            // screen, if Voce cleanup is still the choice.
            start_warm(app);
            Ok(true)
        }
    }
}

/// The cleanup chooser shows Voce cleanup as the current choice (set by
/// `warm_voce_cleanup`, cleared by `cancel_voce_cleanup_warm`).
static WARM_WANTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static WARM_TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

fn voce_saved(settings: &crate::settings::AppSettings) -> bool {
    settings.post_process_enabled
        && settings.post_process_provider_id == crate::settings::VOCE_LOCAL_PROVIDER_ID
}

/// Someone still wants the server warm: the chooser's current choice, or
/// the saved cleanup.
fn warm_intended(app: &tauri::AppHandle) -> bool {
    WARM_WANTED.load(std::sync::atomic::Ordering::Acquire)
        || voce_saved(&crate::settings::get_settings(app))
}

/// Warm the server in the background if it is intended; a newer warm-up
/// replaces an older one. The task can be aborted by
/// `cancel_voce_cleanup_warm` at any point, which retires a half-started
/// server and never touches a server a request holds.
fn start_warm(app: tauri::AppHandle) {
    if !warm_intended(&app) {
        return;
    }
    let idle = idle_after(crate::settings::get_settings(&app).model_unload_timeout);
    let task = tauri::async_runtime::spawn(async move {
        if let Some(sidecar) = sidecar() {
            if let Err(e) = sidecar.warm(idle, &|| warm_intended(&app)).await {
                info!("Voce cleanup warm-up did not run: {e:?}");
            }
        }
    });
    if let Some(old) = WARM_TASK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .replace(task)
    {
        old.abort();
    }
}

/// Voce cleanup is the current choice on screen: start its server in the
/// background, so the first test or dictation does not wait. The first
/// start on a Mac can take many seconds (Metal compiles its kernels once).
#[tauri::command]
#[specta::specta]
pub fn warm_voce_cleanup(app: tauri::AppHandle) {
    WARM_WANTED.store(true, std::sync::atomic::Ordering::Release);
    start_warm(app);
}

/// The user picked another option (or left): stop a warm-up. A server
/// already serving the saved Voce cleanup is left alone.
#[tauri::command]
#[specta::specta]
pub fn cancel_voce_cleanup_warm(app: tauri::AppHandle) {
    WARM_WANTED.store(false, std::sync::atomic::Ordering::Release);
    // A server already started (and idle) goes too, unless Voce cleanup is
    // still the saved choice. Marked before the warm-up is aborted, so a
    // test queued behind it sees the cancellation when it gets the lock.
    if !voce_saved(&crate::settings::get_settings(&app)) {
        if let Some(sidecar) = sidecar() {
            sidecar.release_unwanted();
        }
    }
    if let Some(task) = WARM_TASK.lock().unwrap_or_else(|p| p.into_inner()).take() {
        task.abort();
    }
}

#[tauri::command]
#[specta::specta]
pub fn cancel_voce_cleanup_download() {
    if let Some(token) = DOWNLOAD.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        token.cancel();
    }
}

/// Remove the model (Storage): reserved against requests and starts, so
/// none can begin while the file goes; refused while one is running.
pub fn remove_model() -> Result<(), String> {
    let _removal = match SIDECAR.get() {
        Some(sidecar) => Some(sidecar.reserve_removal()?),
        None => None,
    };
    let dir = models_dir().ok_or("no models folder")?;
    for path in [model_path(dir), partial_path(dir)] {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in llama-server: a Python script that takes `--port`.
    /// `mode` "healthy" serves /health and one chat reply, "exit" exits at
    /// once, "hang" listens but never says healthy.
    pub(crate) fn fake_server(dir: &Path, mode: &str) -> PathBuf {
        let path = dir.join(format!("fake-llama-{mode}"));
        let script = format!(
            r#"#!/usr/bin/env python3
import sys, json, http.server
mode = "{mode}"
if mode == "exit":
    sys.exit(3)
if mode == "slow":
    import time; time.sleep(1.0); mode = "healthy"
port = int(sys.argv[sys.argv.index("--port") + 1])
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200 if mode == "healthy" else 503); self.end_headers(); self.wfile.write(b"{{}}")
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        body = json.dumps({{"choices": [{{"message": {{"content": "I think we should move the standup to Thursday at 10."}}}}]}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
"#
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    pub(crate) fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("voce-local-llm-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub(crate) fn with_model(dir: &Path) -> PathBuf {
        let model = dir.join(MODEL_FILE);
        std::fs::write(&model, b"gguf").unwrap();
        model
    }

    #[test]
    fn server_runs_with_the_parity_flags() {
        let args = server_args(Path::new("/m.gguf"), 4242).join(" ");
        assert_eq!(
            args,
            r#"-m /m.gguf --host 127.0.0.1 --port 4242 -c 4096 -ngl 99 --jinja --temp 0 --repeat-penalty 1.1 --chat-template-kwargs {"enable_thinking":false}"#
        );
    }

    #[tokio::test]
    async fn row11_no_model_file_means_download_needed() {
        let dir = temp_dir("row11");
        let sidecar = Sidecar::new(
            Some(fake_server(&dir, "healthy")),
            dir.join(MODEL_FILE),
            None,
        );
        assert_eq!(
            sidecar.ensure(None, false).await.err(),
            Some(StartError::DownloadNeeded)
        );
    }

    #[tokio::test]
    async fn starts_on_demand_and_reuses_a_healthy_server() {
        let dir = temp_dir("start");
        let sidecar = Sidecar::new(
            Some(fake_server(&dir, "healthy")),
            with_model(&dir),
            Some(dir.clone()),
        );
        assert!(sidecar.running_url().is_none(), "nothing runs before use");
        let first = sidecar.ensure(None, false).await.unwrap().base_url.clone();
        assert!(first.starts_with("http://127.0.0.1:"));
        assert!(dir.join("cleanup-server.pid").is_file());
        let second = sidecar.ensure(None, false).await.unwrap().base_url.clone();
        assert_eq!(first, second, "a healthy server is reused");
        sidecar.stop();
        assert!(sidecar.running_url().is_none());
        assert!(!dir.join("cleanup-server.pid").exists());
    }

    #[tokio::test]
    async fn row12_a_runtime_that_exits_fails_twice_then_gives_up_until_forced() {
        let dir = temp_dir("row12");
        let sidecar = Sidecar::new(Some(fake_server(&dir, "exit")), with_model(&dir), None);
        let started = Instant::now();
        assert_eq!(
            sidecar.ensure(None, false).await.err(),
            Some(StartError::StartFailed)
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "an exit is noticed at once"
        );
        assert!(sidecar.lock().gave_up);
        assert_eq!(
            sidecar.ensure(None, false).await.err(),
            Some(StartError::StartFailed)
        );
        let none = Sidecar::new(None, with_model(&dir), None);
        assert_eq!(
            none.ensure(None, true).await.err(),
            Some(StartError::StartFailed)
        );
    }

    #[tokio::test]
    async fn row12_a_crashed_server_is_started_again_on_next_use() {
        let dir = temp_dir("crash");
        let sidecar = Sidecar::new(Some(fake_server(&dir, "healthy")), with_model(&dir), None);
        let first = sidecar.ensure(None, false).await.unwrap().base_url.clone();
        // Crash it from outside.
        let pid = sidecar.lock().child.as_ref().unwrap().id();
        Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(sidecar.running_url().is_none());
        let again = sidecar.ensure(None, false).await.unwrap().base_url.clone();
        assert_ne!(first, again, "a new server on a new port");
        sidecar.stop();
    }

    fn running(script: &Path) -> bool {
        Command::new("pgrep")
            .args(["-f", &script.to_string_lossy()])
            .status()
            .is_ok_and(|s| s.success())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn review6_quitting_during_startup_leaves_no_server_and_starts_none() {
        let dir = temp_dir("quit");
        let script = fake_server(&dir, "slow");
        let sidecar: &'static Sidecar = Box::leak(Box::new(Sidecar::new(
            Some(script.clone()),
            with_model(&dir),
            None,
        )));
        let start = tokio::spawn(async move { sidecar.ensure(None, false).await.is_ok() });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(sidecar.in_use(), "a start is under way");
        sidecar.shut_down();
        assert!(
            !start.await.unwrap(),
            "the start fails, no retry after quit"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!running(&script), "no server survives the quit");
        assert_eq!(
            sidecar.ensure(None, true).await.err(),
            Some(StartError::StartFailed),
            "nothing starts after quit, even forced"
        );
        assert!(!running(&script));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn review7_the_reaper_never_stops_a_restarting_server() {
        let dir = temp_dir("restart");
        let script = fake_server(&dir, "slow");
        let sidecar: &'static Sidecar = Box::leak(Box::new(Sidecar::new(
            Some(script.clone()),
            with_model(&dir),
            None,
        )));
        // Used once, long idle timeout passed (zero), then it crashes.
        drop(sidecar.ensure(Some(Duration::ZERO), false).await.unwrap());
        let pid = sidecar.lock().child.as_ref().unwrap().id();
        Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        // The restart loads for a second while the reaper keeps ticking.
        let restart = tokio::spawn(async move {
            sidecar
                .ensure(Some(Duration::ZERO), false)
                .await
                .map(|lease| lease.base_url.clone())
        });
        let reaper = std::thread::spawn(move || {
            for _ in 0..40 {
                sidecar.reap_if_idle();
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let url = restart
            .await
            .unwrap()
            .expect("the restart survives the reaper");
        reaper.join().unwrap();
        assert!(url.starts_with("http://127.0.0.1:"));
        // Idle again: now it may go.
        sidecar.reap_if_idle();
        assert!(sidecar.running_url().is_none());
        sidecar.shut_down();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn review3_a_warm_up_cancelled_during_health_polling_leaves_no_server() {
        let dir = temp_dir("warmcancel");
        let script = fake_server(&dir, "slow");
        let sidecar: &'static Sidecar = Box::leak(Box::new(Sidecar::new(
            Some(script.clone()),
            with_model(&dir),
            None,
        )));
        let warm = tokio::spawn(async move { sidecar.warm(None, &|| true).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(sidecar.in_use(), "polling health");
        warm.abort();
        let _ = warm.await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!running(&script) && !sidecar.in_use());
        // A real request afterwards starts normally.
        assert!(sidecar.ensure(None, false).await.is_ok());
        sidecar.shut_down();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn review3_a_queued_warm_up_no_longer_wanted_starts_nothing() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let dir = temp_dir("warmqueue");
        let script = fake_server(&dir, "slow");
        let sidecar: &'static Sidecar = Box::leak(Box::new(Sidecar::new(
            Some(script.clone()),
            with_model(&dir),
            None,
        )));
        static WANTED: AtomicBool = AtomicBool::new(true);
        // Another start holds the start lock...
        let first = tokio::spawn(async move {
            let _ = sidecar.ensure(None, false).await;
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        // ...the warm-up queues behind it, then the user picks another option.
        let warm = tokio::spawn(async move {
            sidecar
                .warm(None, &|| WANTED.load(Ordering::Acquire))
                .await
                .is_ok()
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        WANTED.store(false, Ordering::Release);
        first.abort();
        let _ = first.await;
        assert!(!warm.await.unwrap(), "the queued warm-up gives up");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!running(&script), "and starts no server");
        assert!(
            !sidecar.lock().gave_up,
            "an unwanted warm-up is not a failure"
        );
        sidecar.shut_down();
    }

    #[tokio::test]
    async fn review4_cancelling_after_a_start_retires_the_idle_server_even_with_never_unload() {
        let dir = temp_dir("release");
        let sidecar = Sidecar::new(Some(fake_server(&dir, "healthy")), with_model(&dir), None);
        // "Never unload": idle_after None, so the reaper would keep it forever.
        drop(sidecar.ensure(None, true).await.unwrap());
        sidecar.release_unwanted();
        assert!(sidecar.running_url().is_none(), "idle: retired at once");

        // A request in flight keeps it until the request ends.
        let lease = sidecar.ensure(None, true).await.unwrap();
        sidecar.release_unwanted();
        assert!(
            sidecar.running_url().is_some(),
            "the request's server stays"
        );
        drop(lease);
        assert!(sidecar.running_url().is_none(), "retired when it let go");

        // Wanted again (a warm-up or test): kept after use.
        drop(sidecar.ensure(None, true).await.unwrap());
        assert!(sidecar.running_url().is_some());
        sidecar.stop();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn review5_a_test_queued_behind_a_cancelled_warm_up_starts_no_server() {
        let dir = temp_dir("queuedtest");
        let script = fake_server(&dir, "slow");
        let sidecar: &'static Sidecar = Box::leak(Box::new(Sidecar::new(
            Some(script.clone()),
            with_model(&dir),
            None,
        )));
        // A warm-up holds the start lock while the server loads...
        let warm = tokio::spawn(async move { sidecar.warm(None, &|| true).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        // ...a test (force, always "wanted") queues behind it...
        let test = tokio::spawn(async move { sidecar.ensure(None, true).await.is_ok() });
        tokio::time::sleep(Duration::from_millis(100)).await;
        // ...and the user picks another option ("Never unload": no reaper).
        sidecar.release_unwanted();
        warm.abort();
        let _ = warm.await;
        assert!(!test.await.unwrap(), "the queued test is abandoned");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!running(&script), "no server survives the cancellation");
        // A test asked for after the cancellation runs and keeps its server.
        drop(sidecar.ensure(None, true).await.unwrap());
        assert!(sidecar.running_url().is_some());
        sidecar.shut_down();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn review6_a_cancelled_test_never_blocks_the_dictations_after_it() {
        let dir = temp_dir("nogiveup");
        let script = fake_server(&dir, "slow");
        let sidecar: &'static Sidecar = Box::leak(Box::new(Sidecar::new(
            Some(script.clone()),
            with_model(&dir),
            None,
        )));
        // A test polls health; a dictation waits behind it.
        let test = tokio::spawn(async move { sidecar.ensure(None, true).await.is_ok() });
        tokio::time::sleep(Duration::from_millis(200)).await;
        let dictation = tokio::spawn(async move { sidecar.ensure(None, false).await.is_ok() });
        tokio::time::sleep(Duration::from_millis(100)).await;
        sidecar.release_unwanted(); // the user cancels mid-test
        assert!(!test.await.unwrap(), "the cancelled test does not count");
        assert!(
            dictation.await.unwrap(),
            "the waiting dictation still cleans"
        );
        assert!(!sidecar.lock().gave_up, "a cancellation is not a failure");
        assert!(
            sidecar.ensure(None, false).await.is_ok(),
            "later dictations clean"
        );
        sidecar.shut_down();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn review6_a_dictation_start_spanning_a_cancellation_serves_then_retires() {
        let dir = temp_dir("spanning");
        let script = fake_server(&dir, "slow");
        let sidecar: &'static Sidecar = Box::leak(Box::new(Sidecar::new(
            Some(script.clone()),
            with_model(&dir),
            None,
        )));
        let dictation = tokio::spawn(async move {
            sidecar
                .ensure(None, false)
                .await
                .map(|lease| lease.base_url.clone())
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        sidecar.release_unwanted();
        assert!(dictation.await.unwrap().is_ok(), "the dictation is served");
        assert!(
            sidecar.running_url().is_none(),
            "then the unwanted server goes"
        );

        // A fresh warm-up after the cancellation runs and keeps its server.
        assert!(sidecar.warm(None, &|| true).await.is_ok());
        assert!(sidecar.running_url().is_some());
        sidecar.shut_down();
    }

    fn sha(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn review4_migration_keeps_the_more_complete_partial_either_way() {
        for (old_len, new_len) in [(400usize, 100usize), (100, 400)] {
            let dir = temp_dir(&format!("partials-{old_len}"));
            let (old, new) = (dir.join("models"), dir.join("cleanup"));
            std::fs::create_dir_all(&old).unwrap();
            std::fs::create_dir_all(&new).unwrap();
            std::fs::write(partial_path(&old), vec![1u8; old_len]).unwrap();
            std::fs::write(partial_path(&new), vec![2u8; new_len]).unwrap();
            migrate_model_checked(&old, &new, 4, &sha(b"gguf"));
            assert!(!partial_path(&old).exists());
            let kept = std::fs::read(partial_path(&new)).unwrap();
            assert_eq!(kept.len(), old_len.max(new_len), "more progress wins");
        }
    }

    #[test]
    fn review4_a_valid_old_model_replaces_an_invalid_destination() {
        let dir = temp_dir("invalid-dest");
        let (old, new) = (dir.join("models"), dir.join("cleanup"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(model_path(&old), b"gguf").unwrap();
        std::fs::write(model_path(&new), b"bad!").unwrap();
        migrate_model_checked(&old, &new, 4, &sha(b"gguf"));
        assert_eq!(std::fs::read(model_path(&new)).unwrap(), b"gguf");
        assert!(!model_path(&old).exists());
        // Neither valid: nothing is left to be reported as downloaded.
        std::fs::write(model_path(&old), b"bad1").unwrap();
        std::fs::write(model_path(&new), b"bad2").unwrap();
        migrate_model_checked(&old, &new, 4, &sha(b"gguf"));
        assert!(!model_path(&old).exists() && !model_path(&new).exists());
    }

    #[test]
    fn review3_a_cleanup_model_in_the_speech_folder_moves_to_its_own() {
        let dir = temp_dir("migrate");
        let (old, new) = (dir.join("models"), dir.join("cleanup"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(model_path(&old), b"gguf").unwrap();
        std::fs::write(partial_path(&old), b"gg").unwrap();
        migrate_model_checked(&old, &new, 4, &sha(b"gguf"));
        assert!(!model_path(&old).exists() && !partial_path(&old).exists());
        assert_eq!(std::fs::read(model_path(&new)).unwrap(), b"gguf");
        assert_eq!(std::fs::read(partial_path(&new)).unwrap(), b"gg");
        // A later stray copy goes; the moved, valid one stays.
        std::fs::write(model_path(&old), b"old").unwrap();
        migrate_model_checked(&old, &new, 4, &sha(b"gguf"));
        assert!(!model_path(&old).exists());
        assert_eq!(std::fs::read(model_path(&new)).unwrap(), b"gguf");
    }

    /// Finding 6: after a crash the recorded pid can belong to another
    /// app's llama-server; it survives, and Voce's own leftover is killed.
    #[tokio::test]
    async fn review8_a_reused_pid_never_kills_an_unrelated_llama_server() {
        let dir = temp_dir("reusedpid");
        let pid_file = dir.join("cleanup-server.pid");
        let other_bin = dir.join("llama-server");
        std::os::unix::fs::symlink("/bin/sleep", &other_bin).unwrap();
        let mut other = Command::new(&other_bin).arg("30").spawn().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let alive = |child: &mut std::process::Child| child.try_wait().unwrap().is_none();
        let launch = || Sidecar::new(None, with_model(&dir), Some(dir.clone())).kill_leftover();
        // A crashed Voce's server had this pid with another start time; an
        // older build's file has none, or a `ps lstart` date string; the
        // right start time but another model is not Voce's server either.
        let start = process_start_us(other.id()).unwrap();
        for stale in [
            format!("{}\n{}", other.id(), start - 1),
            other.id().to_string(),
            format!("{}\nThu Jan  1 00:00:00 2026", other.id()),
            format!("{}\n{start}", other.id()),
        ] {
            std::fs::write(&pid_file, stale).unwrap();
            launch();
            assert!(alive(&mut other), "the unrelated llama-server survives");
            assert!(!pid_file.exists());
        }
        other.kill().unwrap();
        let _ = other.wait();

        // Voce's own server left behind by a crash (never retired) goes.
        let sidecar = Sidecar::new(
            Some(fake_server(&dir, "healthy")),
            with_model(&dir),
            Some(dir.clone()),
        );
        drop(sidecar.ensure(None, false).await.unwrap());
        let mut ours = sidecar.lock().child.take().unwrap();
        launch();
        std::thread::sleep(Duration::from_millis(300));
        assert!(!alive(&mut ours), "Voce's leftover server is killed");
        assert!(!pid_file.exists());
    }

    /// Review finding 4 (second pass): the Mac changed time zone and
    /// language between the crash and the relaunch; Voce's own leftover is
    /// still recognized and killed.
    #[tokio::test]
    async fn review9_a_leftover_is_recognized_after_a_time_zone_and_locale_change() {
        let dir = temp_dir("tzchange");
        let sidecar = Sidecar::new(
            Some(fake_server(&dir, "healthy")),
            with_model(&dir),
            Some(dir.clone()),
        );
        drop(sidecar.ensure(None, false).await.unwrap());
        let mut ours = sidecar.lock().child.take().unwrap();
        // What the relaunch's `ps` and clock calls see.
        let before = (std::env::var_os("TZ"), std::env::var_os("LC_ALL"));
        std::env::set_var("TZ", "Pacific/Kiritimati");
        std::env::set_var("LC_ALL", "de_DE.UTF-8");
        Sidecar::new(None, with_model(&dir), Some(dir.clone())).kill_leftover();
        for (key, value) in [("TZ", before.0), ("LC_ALL", before.1)] {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
        std::thread::sleep(Duration::from_millis(300));
        assert!(ours.try_wait().unwrap().is_some(), "the leftover is killed");
    }

    /// Finding 5: a download whose folder cannot be made leaves the slot
    /// free, so Retry after fixing the folder starts a download.
    #[test]
    fn review8_a_failed_download_preparation_never_holds_the_slot() {
        let dir = temp_dir("slot");
        let blocker = dir.join("not-a-folder");
        std::fs::write(&blocker, b"").unwrap();
        let downloading = || DOWNLOAD.lock().unwrap().is_some();
        assert!(begin_download(&blocker.join("cleanup")).is_err());
        assert!(!downloading(), "the failed attempt claimed nothing");
        let slot = begin_download(&dir.join("cleanup")).expect("Retry starts");
        assert!(downloading());
        assert_eq!(
            begin_download(&dir.join("cleanup")).err().as_deref(),
            Some("already downloading")
        );
        drop(slot);
        assert!(!downloading(), "every exit frees the slot");
    }

    #[tokio::test]
    async fn review2_n6_retiring_a_server_keeps_a_replacement_pid_file() {
        let dir = temp_dir("pidfile");
        let sidecar = Sidecar::new(
            Some(fake_server(&dir, "healthy")),
            with_model(&dir),
            Some(dir.clone()),
        );
        drop(sidecar.ensure(None, false).await.unwrap());
        let pid_file = dir.join("cleanup-server.pid");
        // A replacement wrote its pid since: retiring the old server must
        // leave the replacement's file for the next launch to find.
        std::fs::write(&pid_file, "999999").unwrap();
        sidecar.stop();
        assert_eq!(std::fs::read_to_string(&pid_file).unwrap(), "999999");
        // Its own pid file goes with it.
        drop(sidecar.ensure(None, false).await.unwrap());
        sidecar.stop();
        assert!(!pid_file.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn review2_n7_a_cancelled_start_leaves_nothing_busy_or_running() {
        let dir = temp_dir("cancel");
        let script = fake_server(&dir, "slow");
        let sidecar: &'static Sidecar = Box::leak(Box::new(Sidecar::new(
            Some(script.clone()),
            with_model(&dir),
            None,
        )));
        let start = tokio::spawn(async move {
            let _ = sidecar.ensure(Some(Duration::ZERO), false).await;
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(sidecar.in_use(), "health polling");
        start.abort();
        let _ = start.await;
        assert!(!sidecar.in_use(), "starting cleared on cancellation");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!running(&script), "the half-started server is retired");
        // Normal use and idle reaping work afterwards.
        drop(sidecar.ensure(Some(Duration::ZERO), false).await.unwrap());
        sidecar.reap_if_idle();
        assert!(sidecar.running_url().is_none(), "reaped when idle");
        sidecar.shut_down();
    }

    #[tokio::test]
    async fn review2_n8_removal_and_acquisition_exclude_each_other() {
        let dir = temp_dir("remove");
        let sidecar = Sidecar::new(Some(fake_server(&dir, "healthy")), with_model(&dir), None);
        let lease = sidecar.ensure(None, false).await.unwrap();
        assert!(sidecar.reserve_removal().is_err(), "a request holds it");
        drop(lease);
        let removal = sidecar.reserve_removal().expect("idle: may remove");
        assert!(sidecar.running_url().is_none(), "the server stopped first");
        assert_eq!(
            sidecar.ensure(None, true).await.err(),
            Some(StartError::DownloadNeeded),
            "nothing starts while the file goes"
        );
        drop(removal);
        assert!(sidecar.ensure(None, false).await.is_ok());
        sidecar.stop();
    }

    #[tokio::test]
    async fn stops_when_idle_but_never_while_in_use() {
        let dir = temp_dir("idle");
        let sidecar = Sidecar::new(Some(fake_server(&dir, "healthy")), with_model(&dir), None);
        let lease = sidecar.ensure(Some(Duration::ZERO), false).await.unwrap();
        sidecar.reap_if_idle();
        assert!(sidecar.running_url().is_some(), "in use: kept");
        drop(lease);
        sidecar.reap_if_idle();
        assert!(
            sidecar.running_url().is_none(),
            "idle past the timeout: stopped"
        );

        let _lease = sidecar.ensure(None, false).await.unwrap();
        drop(_lease);
        sidecar.reap_if_idle();
        assert!(sidecar.running_url().is_some(), "Never: kept");
        sidecar.stop();
    }
}
