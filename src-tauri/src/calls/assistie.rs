//! Bounded meeting exchanges with separate fictional and locked local-only runs.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::{Mutex, OwnedMutexGuard};

const BRIDGE: &str = include_str!("../../resources/assistie/bridge.py");
const MEMORY: &str = include_str!("../../resources/assistie/memory.py");

#[derive(Clone)]
pub struct AssistieBridge {
    root: PathBuf,
    recovered: Arc<Mutex<bool>>,
}

impl AssistieBridge {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        if app.config().identifier != crate::APP_ID {
            return Err("Meeting bridge is restricted to Voce".into());
        }
        Ok(Self {
            root: app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("assistie"),
            recovered: Arc::new(Mutex::new(false)),
        })
    }
}

#[cfg(unix)]
pub(super) fn prepare(root: &Path) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if root.is_symlink() {
        return Err("Meeting store must not be linked".into());
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    for (name, script) in [("bridge.py", BRIDGE), ("memory.py", MEMORY)] {
        let mut helper = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join(name))
            .map_err(|e| e.to_string())?;
        helper
            .write_all(script.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn prepare(_root: &Path) -> Result<(), String> {
    Err("This private meeting bridge requires a Unix host".into())
}

pub(super) fn exchange_at(
    root: &Path,
    command: &str,
    run_id: Option<&str>,
    payload: Value,
) -> Result<Value, String> {
    let input = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    if input.len() > 8192 {
        return Err("Meeting command exceeds 8 KiB".into());
    }
    let mut command_line = Command::new("/usr/bin/python3");
    command_line
        .args(["-I", "-B", "-c", BRIDGE, "registry", command])
        .arg(root);
    if let Some(run_id) = run_id {
        command_line.arg(run_id);
    }
    let (exit, bytes) = run_helper(command_line, &input, 65536)?;
    let result: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if !exit.success() || result["status"] == "error" {
        return Err(result["error"]
            .as_str()
            .unwrap_or("Meeting exchange failed")
            .to_string());
    }
    Ok(result)
}

/// Runs a Python helper with one JSON input, a size limit on its reply and a three second deadline.
fn run_helper(
    mut command_line: Command,
    input: &[u8],
    limit: u64,
) -> Result<(std::process::ExitStatus, Vec<u8>), String> {
    let mut child = command_line
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let write = child
        .stdin
        .take()
        .ok_or("Missing helper input")?
        .write_all(input);
    if let Err(error) = write {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.to_string());
    }
    let stdout = child.stdout.take().ok_or("Missing helper output")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("Meeting exchange timed out".to_string());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error.to_string());
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| "Meeting output reader failed")?
        .map_err(|e| e.to_string())?;
    let exit = exit?;
    if bytes.len() as u64 > limit {
        return Err("Helper reply is too large".into());
    }
    Ok((exit, bytes))
}

fn memory_exchange(root: &Path, command: &str, payload: &str) -> Result<String, String> {
    if payload.len() > 65536 {
        return Err("Memory command is too large".into());
    }
    let mut command_line = Command::new("/usr/bin/python3");
    command_line
        .args(["-I", "-B", "-c", MEMORY])
        .arg(root)
        .arg(command);
    let (exit, bytes) = run_helper(command_line, payload.as_bytes(), 4 << 20)?;
    let reply = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    if exit.success() {
        return Ok(reply);
    }
    let result: Value = serde_json::from_str(&reply).map_err(|e| e.to_string())?;
    Err(result["error"]
        .as_str()
        .unwrap_or("Memory could not be changed")
        .to_string())
}

/// The Memory page's one way into the store. Importing stays out of the app on purpose.
#[tauri::command]
#[specta::specta]
pub async fn memory_command(
    app: AppHandle,
    command: String,
    payload: String,
) -> Result<String, String> {
    if !["list", "add", "approve", "reject", "delete", "edit"].contains(&command.as_str()) {
        return Err("Unknown memory command".into());
    }
    let (bridge, _guard) = locked_bridge(&app, Gate::On).await?;
    let root = bridge.root.clone();
    tauri::async_runtime::spawn_blocking(move || memory_exchange(&root, &command, &payload))
        .await
        .map_err(|e| e.to_string())?
}

async fn raw(
    bridge: &AssistieBridge,
    command: &'static str,
    run_id: Option<String>,
    value: Value,
) -> Result<Value, String> {
    let root = bridge.root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        exchange_at(&root, command, run_id.as_deref(), value)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Terra is experimental: nothing starts unless Settings > Advanced > Experimental features is on.
pub fn terra_enabled(app: &AppHandle) -> bool {
    crate::settings::get_settings(app).experimental_enabled
}

pub const TERRA_OFF: &str =
    "Terra is an experimental feature. Turn on Experimental features in Settings > Advanced.";

/// What a bridge caller is about to do. Starting, using or sharing Terra needs the switch on; ending it,
/// cleanup and reads of what is already saved never do, so revoking can never be blocked.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Gate {
    On,
    Always,
}

fn permitted(gate: Gate, enabled: bool) -> Result<(), String> {
    if gate == Gate::On && !enabled {
        return Err(TERRA_OFF.into());
    }
    Ok(())
}

/// Ending a run, or switching its sharing off, is revocation; every other bridge change uses Terra.
fn gate_for(command: &str, value: &Value) -> Gate {
    match command {
        "stop" => Gate::Always,
        "controls" if value["sharing"] == json!(false) => Gate::Always,
        _ => Gate::On,
    }
}

/// The switch is read after the bridge lock is taken: the switch-off cleanup holds the same lock, so a command
/// that was already waiting cannot start Terra again after it.
async fn locked_bridge(
    app: &AppHandle,
    gate: Gate,
) -> Result<(AssistieBridge, OwnedMutexGuard<bool>), String> {
    let bridge = app
        .try_state::<AssistieBridge>()
        .ok_or("Meeting bridge unavailable")?
        .inner()
        .clone();
    let mut guard = bridge.recovered.clone().lock_owned().await;
    if !*guard {
        let root = bridge.root.clone();
        tauri::async_runtime::spawn_blocking(move || prepare(&root))
            .await
            .map_err(|e| e.to_string())??;
        raw(&bridge, "recover", None, json!({})).await?;
        *guard = true;
    }
    permitted(gate, terra_enabled(app))?;
    Ok((bridge, guard))
}

pub async fn recover(app: &AppHandle) -> Result<(), String> {
    let _ = locked_bridge(app, Gate::Always).await?;
    Ok(())
}

pub(super) async fn stop_for_call(app: &AppHandle, call_id: String) -> Result<(), String> {
    let (bridge, _guard) = locked_bridge(app, Gate::Always).await?;
    let result = raw(&bridge, "stop_call", None, json!({"call_id":call_id})).await?;
    if result["status"] != "no_matching_call" {
        // The bridge answers a stopped call with that run's snapshot.
        super::notch::hide_after_saved(app.clone(), result["run_id"].as_str().unwrap_or(&call_id));
        let _ = app.emit("assistie-fixture-changed", &result);
    }
    Ok(())
}

/// The Experimental switch changed; the new value is already saved, so every gate sees it. Every off runs its
/// cleanup, even when the switch is back on by the time it runs (a quick off then on still ends the meeting's
/// share, which then needs fresh consent). On resumes a saved plugin connection, as startup does, only if the
/// switch is still on; nothing shares until Terra is turned on for a meeting. A quick off then on can find the old
/// supervisor still alive (so its resume does nothing) and then lose it to the off's cleanup, so the cleanup
/// resumes once more at its end if the switch is on by then.
pub fn experimental_switched(app: AppHandle, enabled: bool) {
    if enabled {
        if terra_enabled(&app) {
            super::plugin::resume_saved(&app);
        }
        return;
    }
    tauri::async_runtime::spawn(async move {
        let errors = off_then_resume(
            || switch_off(&app),
            || terra_enabled(&app),
            || super::plugin::resume_saved(&app),
        )
        .await;
        for error in errors {
            log::warn!("Turning Terra off: {error}");
        }
    });
}

/// Runs the switch-off cleanup, then resumes the saved connection if the switch is on by the time it ends.
async fn off_then_resume<C, F>(
    cleanup: C,
    enabled: impl Fn() -> bool,
    resume: impl FnOnce(),
) -> Vec<String>
where
    C: FnOnce() -> F,
    F: std::future::Future<Output = Vec<String>>,
{
    let errors = cleanup().await;
    if enabled() {
        resume();
    }
    errors
}

async fn switch_off(app: &AppHandle) -> Vec<String> {
    let bridge = locked_bridge(app, Gate::Always).await;
    end_terra(
        || async {
            // The guard lives to the end of this step, so no connect can launch a responder between the stop
            // and the shutdown below. The responder is shut down even when the bridge or the stop failed.
            let stopped = match &bridge {
                Ok((bridge, _guard)) => stop_current(app, bridge).await,
                Err(error) => Err(error.clone()),
            };
            let app = app.clone();
            let shutdown = tauri::async_runtime::spawn_blocking(move || {
                if let Some(runtime) = app.try_state::<super::responder::TerraRuntime>() {
                    runtime.shutdown();
                }
            })
            .await
            .map_err(|e| e.to_string());
            drop(bridge);
            stopped.and(shutdown)
        },
        || async {
            super::notch::set_assistie_notch_visible(app.clone(), false)
                .await
                .map(|_| ())
        },
        || async {
            // Last, because a launch holds the plugin lock while it waits on the Keychain prompt; that launch
            // refuses once the read returns, since the switch is already saved as off.
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Some(runtime) = app.try_state::<super::plugin::PluginRuntime>() {
                    runtime.shutdown();
                }
            })
            .await
            .map_err(|e| e.to_string())
        },
    )
    .await
}

async fn stop_current(app: &AppHandle, bridge: &AssistieBridge) -> Result<(), String> {
    // `identity`, never `current`: a snapshot syncs fresh meeting text into the shared store, and revocation must
    // not share anything new first (the same rule as `mutate`). No run is nothing to stop; stop is idempotent.
    let current = raw(bridge, "identity", None, json!({})).await?;
    let Some(run_id) = current["run_id"].as_str() else {
        return Ok(());
    };
    let stopped = snapshot(bridge, "stop", Some(run_id.to_string()), json!({})).await?;
    let _ = app.emit("assistie-fixture-changed", &stopped);
    Ok(())
}

/// Every step is tried even when an earlier one fails: the switch is already saved as off, so a failed bridge
/// stop must not leave the responder, the notch or the tunnel running. Returns the errors, in order.
async fn end_terra<A, B, C, FA, FB, FC>(
    stop_and_responder: A,
    hide_notch: B,
    stop_plugin: C,
) -> Vec<String>
where
    A: FnOnce() -> FA,
    B: FnOnce() -> FB,
    C: FnOnce() -> FC,
    FA: std::future::Future<Output = Result<(), String>>,
    FB: std::future::Future<Output = Result<(), String>>,
    FC: std::future::Future<Output = Result<(), String>>,
{
    let mut errors = Vec::new();
    for result in [
        stop_and_responder().await,
        hide_notch().await,
        stop_plugin().await,
    ] {
        if let Err(error) = result {
            errors.push(error);
        }
    }
    errors
}

#[derive(Serialize, Deserialize, specta::Type)]
pub struct Source {
    id: String,
    text: String,
    /// "you" or "other_audio" for transcript lines; absent for seeded notes.
    #[serde(default)]
    source: Option<String>,
    /// Time from the start of the call.
    #[serde(default)]
    start_ms: Option<u64>,
}
#[derive(Serialize, Deserialize, specta::Type)]
pub struct Brief {
    text: String,
    source: String,
    marker: String,
}
#[derive(Serialize, Deserialize, specta::Type)]
pub struct Question {
    id: u32,
    text: String,
    version: u32,
    status: String,
}
#[derive(Serialize, Deserialize, specta::Type)]
pub struct Reply {
    event_id: String,
    question_id: Option<u32>,
    kind: String,
    version: u32,
    #[serde(default)]
    snapshot_at_ms: Option<i64>,
    #[serde(default)]
    source_status: Option<String>,
    #[serde(default)]
    received_at_ms: Option<i64>,
    text: String,
    quotes: Vec<Source>,
}

/// One page of a run's replies for the notch chat, oldest first, numbered like reply-NNNNNN.json.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct FeedItem {
    n: u32,
    reply: Reply,
    question: Option<Question>,
}
#[derive(Serialize, Deserialize, specta::Type)]
pub struct FeedPage {
    run_id: String,
    reply_count: u32,
    items: Vec<FeedItem>,
    more_before: bool,
}
#[derive(Serialize, Deserialize, specta::Type)]
pub struct Connection {
    id: String,
    phase: String,
    requested_at_ms: i64,
    last_attempt_ms: i64,
    attempts: u32,
    claimed_at_ms: Option<i64>,
    ready_at_ms: Option<i64>,
}

/// The user's mark on a Terra reply (or a missed moment) and whether its private case was saved.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct Mark {
    id: String,
    event_id: Option<String>,
    rating: String,
    note: String,
    at_ms: i64,
    status: String,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize, Deserialize, specta::Type)]
pub struct Snapshot {
    pub(super) run_id: String,
    status: String,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    connection: Option<Connection>,
    sharing: bool,
    proactive: bool,
    deadline_ms: Option<i64>,
    startup_deadline_ms: Option<i64>,
    version: u32,
    #[serde(default)]
    feed_sequence: u32,
    #[serde(default)]
    local_only: bool,
    #[serde(default)]
    call_id: Option<String>,
    #[serde(default)]
    feed_error: Option<String>,
    #[serde(default)]
    archive: bool,
    #[serde(default)]
    history_offset: u32,
    #[serde(default)]
    history_more: bool,
    #[serde(default)]
    question_limit: Option<u32>,
    #[serde(default)]
    questions_asked: Option<u32>,
    context_brief: Option<Brief>,
    questions: Vec<Question>,
    replies: Vec<Reply>,
    #[serde(default)]
    marks: Vec<Mark>,
    #[serde(default)]
    reply_count: Option<u32>,
    /// Your own newest line is still being spoken; pointer peeks wait for it.
    #[serde(default)]
    you_speaking: bool,
    /// Terra is working on a question or deciding on a pointer.
    #[serde(default)]
    terra_working: bool,
    #[serde(default)]
    terra_working_since_ms: Option<i64>,
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TranscriptSegment {
    pub id: String,
    pub source: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub finalized: bool,
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TranscriptBatch {
    pub sequence: u32,
    pub base_version: u32,
    pub segments: Vec<TranscriptSegment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_ids: Vec<String>,
}

impl Snapshot {
    pub fn allows_notch(&self) -> bool {
        !self.local_only && self.sharing && matches!(self.status.as_str(), "waiting" | "following")
    }
}

async fn snapshot(
    bridge: &AssistieBridge,
    command: &'static str,
    run_id: Option<String>,
    value: Value,
) -> Result<Snapshot, String> {
    serde_json::from_value(raw(bridge, command, run_id, value).await?).map_err(|e| e.to_string())
}

pub async fn notch_allowed(app: &AppHandle) -> Result<bool, String> {
    // `current` syncs meeting text, so it is never read while Terra is off: off simply means no notch.
    let (bridge, _guard) = match locked_bridge(app, Gate::On).await {
        Err(error) if error == TERRA_OFF => return Ok(false),
        other => other?,
    };
    Ok(snapshot(&bridge, "current", None, json!({}))
        .await?
        .allows_notch())
}

async fn create_session<F, Fut>(bridge: &AssistieBridge, hide: F) -> Result<Snapshot, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<bool, String>>,
{
    // Allocation failure must leave the current session's visible controls intact.
    let result = snapshot(bridge, "create_demo", None, json!({})).await?;
    hide().await?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn create_assistie_fixture(app: AppHandle) -> Result<Snapshot, String> {
    let (bridge, _guard) = locked_bridge(&app, Gate::On).await?;
    let result = create_session(&bridge, || {
        super::notch::set_assistie_notch_visible(app.clone(), false)
    })
    .await?;
    let _ = app.emit("assistie-fixture-changed", &result);
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn create_call_assistie(app: AppHandle, session_id: String) -> Result<Snapshot, String> {
    let (bridge, _guard) = locked_bridge(&app, Gate::On).await?;
    if app
        .state::<super::CallNotesManager>()
        .active_session_id()
        .as_deref()
        != Some(&session_id)
    {
        return Err("Open the current recording before inviting Assistie".into());
    }
    // Allocates an empty, sharing-off exchange. The helper binds it to this call's
    // current local ASR run; transcript reads begin only after explicit consent.
    let result = snapshot(
        &bridge,
        "create_call",
        None,
        json!({"call_id":session_id,"owner_pid":std::process::id()}),
    )
    .await?;
    if !result.allows_notch() {
        super::notch::set_assistie_notch_visible(app.clone(), false).await?;
    }
    let _ = app.emit("assistie-fixture-changed", &result);
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn copy_assistie_connection(app: AppHandle, run_id: String) -> Result<(), String> {
    let (bridge, _guard) = locked_bridge(&app, Gate::On).await?;
    let result = raw(&bridge, "handoff", Some(run_id), json!({})).await?;
    let prompt = result["prompt"]
        .as_str()
        .ok_or("Missing meeting connection message")?;
    app.clipboard()
        .write_text(prompt)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn connect_assistie_meeting(
    app: AppHandle,
    run_id: String,
    proactive: bool,
) -> Result<Snapshot, String> {
    // Pairing never grants meeting access. Only the consent form calls this command.
    super::plugin::start_assistie_plugin(app.clone()).await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !super::plugin::ready_for_meetings(&app).await {
        if Instant::now() >= deadline {
            return Err(
                "Assistie connection is unavailable. Check the one-time plugin connection.".into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    mutate(
        app,
        run_id,
        "connect",
        json!({"proactive":proactive}),
        false,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn connect_terra_meeting(
    app: AppHandle,
    run_id: String,
    proactive: bool,
) -> Result<Snapshot, String> {
    // Only the consent form calls this. The bridge owns the route; Handy only starts the process.
    let (bridge, _guard) = locked_bridge(&app, Gate::On).await?;
    let current = raw(&bridge, "identity", None, json!({})).await?;
    if current["run_id"].as_str() != Some(&run_id) {
        return Err("Meeting changed; reopen its current controls".into());
    }
    // A broken memory store must stop here, before anything is shared.
    let root = bridge.root.clone();
    tauri::async_runtime::spawn_blocking(move || memory_exchange(&root, "check", "{}"))
        .await
        .map_err(|e| e.to_string())??;
    // The last check before sharing turns on: the identity read and the memory check above both await, and the
    // switch may have gone off meanwhile (its cleanup waits behind this lock).
    permitted(Gate::On, terra_enabled(&app))?;
    let value = raw(
        &bridge,
        "connect_codex",
        Some(run_id.clone()),
        json!({"proactive":proactive}),
    )
    .await?;
    let connection = value["connection"]["id"]
        .as_str()
        .ok_or("Missing Terra connection")?
        .to_string();
    // Nothing reaches ChatGPT until the responder runs, so sharing must be visible before it starts.
    if !matches!(super::notch::show_for_share(app.clone()).await, Ok(true)) {
        let _ = raw(&bridge, "stop", Some(run_id), json!({})).await;
        return Err("Terra needs the notch to be visible".into());
    }
    // The switch may have gone off while this connect held the lock; its cleanup is waiting behind it. Checked
    // again right before the launch so no responder starts for it.
    if !terra_enabled(&app) {
        let _ = raw(&bridge, "stop", Some(run_id), json!({})).await;
        let _ = super::notch::set_assistie_notch_visible(app.clone(), false).await;
        return Err(TERRA_OFF.into());
    }
    let launched = {
        let app = app.clone();
        let run_id = run_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            super::responder::launch(&app, &run_id, &connection)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    if let Err(error) = launched {
        // Never leave a consented meeting waiting on a responder that is not running.
        let _ = raw(&bridge, "stop", Some(run_id), json!({})).await;
        return Err(error);
    }
    let result: Snapshot = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let _ = app.emit("assistie-fixture-changed", &result);
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn rate_terra_reply(
    app: AppHandle,
    run_id: String,
    event_id: Option<String>,
    rating: String,
    note: String,
) -> Result<Snapshot, String> {
    // Marks feed Terra's private evaluation cases; the responder writes them, so it must be alive.
    if !super::responder::running(&app) {
        return Err("Terra is not running for this meeting".into());
    }
    mutate(
        app,
        run_id,
        "rate",
        json!({"event_id":event_id,"rating":rating,"note":note}),
        false,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn retry_assistie_connection(app: AppHandle, run_id: String) -> Result<Snapshot, String> {
    super::plugin::start_assistie_plugin(app.clone()).await?;
    mutate(app, run_id, "retry_connect", json!({}), false).await
}

#[tauri::command]
#[specta::specta]
pub async fn saved_call_assistie(
    app: AppHandle,
    session_id: String,
    offset: u32,
) -> Result<Snapshot, String> {
    let (bridge, _guard) = locked_bridge(&app, Gate::Always).await?;
    snapshot(
        &bridge,
        "call_history",
        None,
        json!({"call_id":session_id,"offset":offset}),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn assistie_fixture_snapshot(
    app: AppHandle,
    run_id: Option<String>,
) -> Result<Snapshot, String> {
    // `current` and `snapshot` sync fresh meeting text into the shared store: refused while Terra is off.
    let (bridge, _guard) = locked_bridge(&app, Gate::On).await?;
    let current = snapshot(&bridge, "current", None, json!({})).await?;
    if current.allows_notch() {
        super::notch::notch_run_live();
    } else if super::notch::assistie_notch_visible(app.clone()) {
        super::notch::hide_after_saved(app, &current.run_id);
    }
    match run_id {
        Some(id) if id != current.run_id => {
            snapshot(&bridge, "snapshot", Some(id), json!({})).await
        }
        _ => Ok(current),
    }
}

async fn mutate(
    app: AppHandle,
    run_id: String,
    command: &'static str,
    value: Value,
    hide: bool,
) -> Result<Snapshot, String> {
    let gate = gate_for(command, &value);
    let (bridge, _guard) = locked_bridge(&app, gate).await?;
    // Revocation must not refresh or export new transcript text first.
    let current = raw(&bridge, "identity", None, json!({})).await?;
    if current["run_id"].as_str() != Some(&run_id) {
        return Err("Meeting changed; reopen its current controls".into());
    }
    // The identity read awaits, and the switch may have gone off meanwhile (its cleanup waits behind this lock):
    // checked again right before a command that can sync meeting text.
    permitted(gate, terra_enabled(&app))?;
    let result = snapshot(&bridge, command, Some(run_id), value).await?;
    if hide {
        super::notch::hide_after_saved(app.clone(), &result.run_id);
    }
    let _ = app.emit("assistie-fixture-changed", &result);
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn stop_assistie_fixture(app: AppHandle, run_id: String) -> Result<Snapshot, String> {
    mutate(app, run_id, "stop", json!({}), true).await
}

/// The notch chat's history. `before` pages back, `after` fetches new arrivals; at most one is set.
#[tauri::command]
#[specta::specta]
pub async fn assistie_notch_feed(
    app: AppHandle,
    run_id: String,
    before: Option<u32>,
    after: Option<u32>,
    limit: u32,
) -> Result<FeedPage, String> {
    let (bridge, _guard) = locked_bridge(&app, Gate::Always).await?;
    let value = raw(
        &bridge,
        "feed",
        Some(run_id),
        json!({"before":before,"after":after,"limit":limit}),
    )
    .await?;
    serde_json::from_value(value).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn ask_assistie_fixture(
    app: AppHandle,
    run_id: String,
    question: String,
) -> Result<Snapshot, String> {
    if question.trim().is_empty() || question.chars().count() > 800 {
        return Err("Use 1 to 800 characters".into());
    }
    mutate(app, run_id, "ask", json!({"question":question}), false).await
}

#[tauri::command]
#[specta::specta]
pub async fn control_assistie_fixture(
    app: AppHandle,
    run_id: String,
    sharing: bool,
    proactive: bool,
) -> Result<Snapshot, String> {
    let plugin = sharing && super::plugin::ready_for_meetings(&app).await;
    mutate(
        app,
        run_id,
        "controls",
        json!({"sharing":sharing,"proactive":proactive,"transport":if plugin {"plugin"} else {"worker"}}),
        !sharing,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn append_assistie_transcript(
    app: AppHandle,
    run_id: String,
    batch: TranscriptBatch,
) -> Result<Snapshot, String> {
    mutate(
        app,
        run_id,
        "transcript",
        serde_json::to_value(batch).map_err(|e| e.to_string())?,
        false,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_status_survives_the_snapshot() {
        let mut value: Value = serde_json::from_str(
            r#"{"run_id":"meeting-x","status":"following","sharing":true,"proactive":false,
            "deadline_ms":null,"startup_deadline_ms":null,"version":1,"context_brief":null,
            "questions":[],"replies":[]}"#,
        )
        .unwrap();
        let older: Snapshot = serde_json::from_value(value.clone()).unwrap();
        assert!(older.marks.is_empty());
        value["marks"] = json!([{"id":"m1","event_id":null,"rating":"missed","note":"","at_ms":1,
            "status":"failed","error":"Terra stopped before saving this mark"}]);
        let snapshot: Snapshot = serde_json::from_value(value).unwrap();
        let round = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(round["marks"][0]["status"], "failed");
        assert_eq!(
            round["marks"][0]["error"],
            "Terra stopped before saving this mark"
        );
    }

    #[test]
    fn live_call_binding_round_trips_without_capture_or_unconsented_text() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path().join("assistie");
        let local = data.path().join("assistie-local");
        let call = data.path().join("calls/fictional-call-21");
        std::fs::create_dir_all(&call).unwrap();
        prepare(&root).unwrap();
        prepare(&local).unwrap();
        let source = exchange_at(
            &local,
            "create_local",
            None,
            json!({"call_id":"fictional-call-21","recording_key":"a".repeat(64)}),
        )
        .unwrap();
        let source_id = source["run_id"].as_str().unwrap();
        std::fs::write(
            call.join("session.json"),
            r#"{"id":"fictional-call-21","active":true,"notes":"private notes"}"#,
        )
        .unwrap();
        std::fs::write(
            call.join("live-feed.json"),
            serde_json::to_vec(&json!({"status":"following","local_only":true,"run_id":source_id}))
                .unwrap(),
        )
        .unwrap();
        let payload = json!({"call_id":"fictional-call-21","owner_pid":std::process::id()});
        let created = exchange_at(&root, "create_call", None, payload).unwrap();
        let id = created["run_id"].as_str().unwrap();
        let off: Snapshot = serde_json::from_value(created.clone()).unwrap();
        assert_eq!(off.call_id.as_deref(), Some("fictional-call-21"));
        assert!(!off.allows_notch());
        exchange_at(
            &local,
            "transcript",
            Some(source_id),
            json!({
            "sequence":1,"base_version":1,"segments":[{"id":"s1","source":"other_audio",
            "start_ms":0,"end_ms":1000,"text":"Fictional Monday launch","finalized":true}]}),
        )
        .unwrap();
        let source_before = std::fs::read(local.join(source_id).join("state.json")).unwrap();
        assert_eq!(
            exchange_at(&root, "snapshot", Some(id), json!({})).unwrap()["version"],
            1
        );
        let on: Snapshot = serde_json::from_value(
            exchange_at(
                &root,
                "controls",
                Some(id),
                json!({"sharing":true,"proactive":false}),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(on.allows_notch());
        assert_eq!(on.version, 2);
        assert_eq!(
            std::fs::read(local.join(source_id).join("state.json")).unwrap(),
            source_before
        );
        let stopped: Snapshot = serde_json::from_value(
            exchange_at(
                &root,
                "stop_call",
                None,
                json!({"call_id":"fictional-call-21"}),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(!stopped.allows_notch());
        assert!(exchange_at(
            &root,
            "controls",
            Some(id),
            json!({"sharing":true,"proactive":false})
        )
        .is_err());
    }

    #[test]
    fn incremental_batches_round_trip_through_embedded_bridge() {
        let temp = tempfile::tempdir().unwrap();
        prepare(temp.path()).unwrap();
        let value = exchange_at(temp.path(), "create", None, json!({})).unwrap();
        let id = value["run_id"].as_str().unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../resources/assistie/fictional_stream.json"
        ))
        .unwrap();
        for (index, batch) in fixture["batches"].as_array().unwrap().iter().enumerate() {
            let typed: TranscriptBatch = serde_json::from_value(batch.clone()).unwrap();
            let payload = serde_json::to_value(typed).unwrap();
            let current =
                exchange_at(temp.path(), "transcript", Some(id), payload.clone()).unwrap();
            let snapshot: Snapshot = serde_json::from_value(current.clone()).unwrap();
            assert_eq!(snapshot.feed_sequence, index as u32 + 1);
            assert_eq!(snapshot.version, index as u32 + 2);
            assert!(!snapshot.sharing);
            assert_eq!(
                exchange_at(temp.path(), "transcript", Some(id), payload).unwrap(),
                current
            );
        }
        exchange_at(temp.path(), "stop", Some(id), json!({})).unwrap();
        assert!(exchange_at(
            temp.path(),
            "transcript",
            Some(id),
            fixture["batches"][1].clone()
        )
        .is_err());
        assert!(exchange_at(
            temp.path(),
            "transcript",
            Some(id),
            json!({"x":"a".repeat(8193)})
        )
        .is_err());
    }

    #[test]
    fn saved_history_remains_read_only_after_startup_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("assistie");
        prepare(&root).unwrap();
        let call = temp.path().join("calls/fictional-history-24");
        std::fs::create_dir_all(&call).unwrap();
        std::fs::write(
            call.join("session.json"),
            r#"{"id":"fictional-history-24","active":false}"#,
        )
        .unwrap();
        let created = exchange_at(&root, "create", None, json!({})).unwrap();
        let id = created["run_id"].as_str().unwrap();
        let path = root.join(id).join("state.json");
        let mut state: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        state["call_binding"] = json!({"call_id":"fictional-history-24"});
        state["questions"] = json!([{"id":1,"text":"What day?","status":"answered","version":1}]);
        state["replies"] = json!([{"event_id":"q1","question_id":1,"kind":"answer","version":1,"snapshot_at_ms":1,
            "text":"Fictional Monday.","quotes":[{"id":"s1","text":"Fictional Monday agreement."}]}]);
        std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
        // Represent a pre-index saved store whose binding is discovered during migration.
        std::fs::rename(
            root.join("sessions.sqlite3"),
            root.join("fixture-index-backup"),
        )
        .unwrap();
        exchange_at(&root, "recover", None, json!({})).unwrap();
        let before = std::fs::read(&path).unwrap();
        let archive: Snapshot = serde_json::from_value(
            exchange_at(
                &root,
                "call_history",
                None,
                json!({"call_id":"fictional-history-24","offset":0}),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(archive.archive);
        assert!(!archive.allows_notch());
        assert_eq!(archive.replies[0].text, "Fictional Monday.");
        assert_eq!(archive.questions[0].text, "What day?");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(exchange_at(&root, "identity", None, json!({})).unwrap()["run_id"].is_null());
    }

    #[tokio::test]
    async fn allocation_failure_never_hides_the_current_notch() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("assistie");
        prepare(&root).unwrap();
        let bridge = AssistieBridge {
            root: root.clone(),
            recovered: Arc::new(Mutex::new(true)),
        };
        let hidden = std::sync::atomic::AtomicBool::new(false);
        create_session(&bridge, || async {
            hidden.store(true, std::sync::atomic::Ordering::Relaxed);
            Ok(false)
        })
        .await
        .unwrap();
        assert!(hidden.load(std::sync::atomic::Ordering::Relaxed));
        for _ in 1..65 {
            exchange_at(&root, "create", None, json!({})).unwrap();
        }
        let current = exchange_at(&root, "current", None, json!({})).unwrap();
        let id = current["run_id"].as_str().unwrap();
        exchange_at(
            &root,
            "controls",
            Some(id),
            json!({"sharing":true,"proactive":false}),
        )
        .unwrap();
        hidden.store(false, std::sync::atomic::Ordering::Relaxed);
        let catalog = root.join("sessions.sqlite3");
        let backup = temp.path().join("catalog-backup");
        std::fs::rename(&catalog, &backup).unwrap();
        std::fs::create_dir(&catalog).unwrap();
        assert!(create_session(&bridge, || async {
            hidden.store(true, std::sync::atomic::Ordering::Relaxed);
            Ok(false)
        })
        .await
        .is_err());
        assert!(!hidden.load(std::sync::atomic::Ordering::Relaxed));
        std::fs::remove_dir(&catalog).unwrap();
        std::fs::rename(&backup, &catalog).unwrap();
        let after = exchange_at(&root, "current", None, json!({})).unwrap();
        assert_eq!(after["run_id"], id);
        assert_eq!(after["sharing"], true);
    }

    #[test]
    fn connect_consent_round_trips_without_starting_a_worker() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("assistie");
        prepare(&root).unwrap();
        let created = exchange_at(&root, "create_demo", None, json!({})).unwrap();
        let run = created["run_id"].as_str().unwrap();
        let connected =
            exchange_at(&root, "connect", Some(run), json!({"proactive":false})).unwrap();
        let snapshot: Snapshot = serde_json::from_value(connected).unwrap();
        assert!(snapshot.sharing);
        assert!(!snapshot.proactive);
        assert_eq!(snapshot.status, "waiting");
        let connection = snapshot.connection.unwrap();
        assert_eq!(connection.phase, "requested");
        assert_eq!(connection.attempts, 1);
        assert!(connection.ready_at_ms.is_none());
        exchange_at(&root, "stop", Some(run), json!({})).unwrap();
        assert_eq!(
            exchange_at(&root, "plugin_read", Some(run), json!({})).unwrap()["status"],
            "disabled"
        );
    }

    #[test]
    fn fictional_demo_creates_a_readable_saved_call_without_audio() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("assistie");
        prepare(&root).unwrap();
        let created = exchange_at(&root, "create_demo", None, json!({})).unwrap();
        assert_eq!(created["sharing"], false);
        assert!(created["call_id"].is_null());
        let call = std::fs::read_dir(temp.path().join("calls"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let session: super::super::CallSession =
            super::super::analysis::read(&call.join("session.json")).unwrap();
        assert!(!session.active);
        assert!(session.title.contains("no recording"));
        assert!(session.mic_segments.is_empty());
        assert_eq!(session.system.samples, 0);
        assert_eq!(std::fs::read_dir(&call).unwrap().count(), 1);
        let history = exchange_at(
            &root,
            "call_history",
            None,
            json!({"call_id":session.id,"offset":0}),
        )
        .unwrap();
        assert_eq!(history["archive"], true);
        assert_eq!(history["sharing"], false);
    }

    #[test]
    fn session_switch_recovery_and_stale_requests_are_isolated() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        prepare(root).unwrap();
        let call = |command, id: Option<&str>, value| exchange_at(root, command, id, value);
        let a = call("create", None, json!({})).unwrap();
        let a = a["run_id"].as_str().unwrap();
        call(
            "controls",
            Some(a),
            json!({"sharing":true,"proactive":true}),
        )
        .unwrap();
        call("ask", Some(a), json!({"question":"Fictional A?"})).unwrap();
        let b = call("create", None, json!({})).unwrap();
        let b = b["run_id"].as_str().unwrap();
        assert_ne!(a, b);
        assert_eq!(
            call("snapshot", Some(a), json!({})).unwrap()["status"],
            "disabled"
        );
        assert!(call("stop", Some(a), json!({})).is_err());
        assert_eq!(call("current", None, json!({})).unwrap()["run_id"], b);
        assert_eq!(
            call("snapshot", Some(b), json!({})).unwrap()["questions"],
            json!([])
        );
        call(
            "controls",
            Some(b),
            json!({"sharing":true,"proactive":false}),
        )
        .unwrap();
        call("recover", None, json!({})).unwrap();
        assert!(call("current", None, json!({})).is_err());
        assert_eq!(
            call("snapshot", Some(b), json!({})).unwrap()["status"],
            "disabled"
        );
    }

    #[test]
    fn unknown_paths_are_rejected_and_controls_start_off() {
        let temp = tempfile::tempdir().unwrap();
        prepare(temp.path()).unwrap();
        assert!(exchange_at(temp.path(), "snapshot", Some("../../outside"), json!({})).is_err());
        let value = exchange_at(temp.path(), "create", None, json!({})).unwrap();
        let snapshot: Snapshot = serde_json::from_value(value).unwrap();
        assert!(!snapshot.allows_notch());
        assert!(!snapshot.proactive);
    }

    /// Terra gate rows 3 and 4: starting or using Terra needs the Experimental switch; revoking never does.
    #[test]
    fn terra_gate_rows3_4_only_use_needs_the_switch() {
        assert_eq!(permitted(Gate::On, false), Err(TERRA_OFF.to_string()));
        assert_eq!(permitted(Gate::On, true), Ok(()));
        assert_eq!(permitted(Gate::Always, false), Ok(()));
        assert_eq!(gate_for("stop", &json!({})), Gate::Always);
        assert_eq!(
            gate_for("controls", &json!({"sharing":false,"proactive":false})),
            Gate::Always
        );
        assert_eq!(
            gate_for("controls", &json!({"sharing":true,"proactive":false})),
            Gate::On
        );
        for used in ["ask", "transcript", "connect", "retry_connect", "rate"] {
            assert_eq!(gate_for(used, &json!({})), Gate::On, "{used}");
        }
    }

    /// Terra gate row 3: every way into the bridge names its gate, and the list below is the decision for each.
    /// A new caller fails this test until it is added here on purpose.
    #[test]
    fn terra_gate_row3_every_bridge_caller_has_the_intended_gate() {
        let expected = [
            ("memory_command", "Gate::On"),
            ("recover", "Gate::Always"),
            ("stop_for_call", "Gate::Always"),
            ("switch_off", "Gate::Always"),
            ("notch_allowed", "Gate::On"),
            ("create_assistie_fixture", "Gate::On"),
            ("create_call_assistie", "Gate::On"),
            ("copy_assistie_connection", "Gate::On"),
            ("connect_terra_meeting", "Gate::On"),
            ("saved_call_assistie", "Gate::Always"),
            ("assistie_fixture_snapshot", "Gate::On"),
            ("mutate", "gate"),
            ("assistie_notch_feed", "Gate::Always"),
        ];
        let source = include_str!("assistie.rs");
        let source = &source[..source.find("#[cfg(test)]").unwrap()];
        let mut found = Vec::new();
        let mut current = "";
        for line in source.lines() {
            let trimmed = line.trim_start();
            for prefix in [
                "pub async fn ",
                "async fn ",
                "pub(super) async fn ",
                "pub fn ",
                "fn ",
            ] {
                if let Some(rest) = trimmed.strip_prefix(prefix) {
                    current = &rest[..rest.find(['(', '<']).unwrap()];
                }
            }
            if let Some(at) = line.find("locked_bridge(") {
                if current == "locked_bridge" {
                    continue;
                }
                let args = &line[at + "locked_bridge(".len()..];
                let gate = args.split_once(", ").unwrap().1;
                found.push((
                    current.to_string(),
                    gate[..gate.rfind(')').unwrap()].to_string(),
                ));
            }
        }
        let expected: Vec<_> = expected
            .iter()
            .map(|(f, g)| (f.to_string(), g.to_string()))
            .collect();
        assert_eq!(found, expected);
    }

    /// Terra gate rows 5 and 6: switching off tries every step in order, even when the bridge stop fails, and
    /// reports what failed.
    #[tokio::test]
    async fn terra_gate_rows5_6_switch_off_tries_every_step() {
        let steps = std::sync::Mutex::new(Vec::new());
        let errors = end_terra(
            || async {
                steps.lock().unwrap().push("stop and responder");
                Err("bridge unavailable".to_string())
            },
            || async {
                steps.lock().unwrap().push("hide notch");
                Ok(())
            },
            || async {
                steps.lock().unwrap().push("stop plugin");
                Ok(())
            },
        )
        .await;
        assert_eq!(
            *steps.lock().unwrap(),
            ["stop and responder", "hide notch", "stop plugin"]
        );
        assert_eq!(errors, ["bridge unavailable"]);
        let quiet = end_terra(
            || async { Ok(()) },
            || async { Ok(()) },
            || async { Ok(()) },
        )
        .await;
        assert!(quiet.is_empty());
    }

    /// Codex review 1, finding 2: a quick off then on. The on's resume finds the old supervisor alive and does
    /// nothing, then the off's cleanup stops it; the cleanup resumes once more when the switch is on by its end,
    /// and not when it stays off, even when a step failed.
    #[tokio::test]
    async fn terra_gate_quick_off_then_on_resumes_after_the_cleanup() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let on = AtomicBool::new(false);
        let resumed = AtomicBool::new(false);
        let errors = off_then_resume(
            || async {
                on.store(true, Ordering::Release); // switched back on while the cleanup runs
                vec!["bridge unavailable".to_string()]
            },
            || on.load(Ordering::Acquire),
            || resumed.store(true, Ordering::Release),
        )
        .await;
        assert!(resumed.load(Ordering::Acquire), "the tunnel stayed stopped");
        assert_eq!(errors, ["bridge unavailable"]);
        on.store(false, Ordering::Release);
        resumed.store(false, Ordering::Release);
        off_then_resume(
            || async { Vec::new() },
            || on.load(Ordering::Acquire),
            || resumed.store(true, Ordering::Release),
        )
        .await;
        assert!(!resumed.load(Ordering::Acquire), "resumed while off");
    }

    /// Codex review 1, finding 1: `mutate` checks the switch again after its `identity` read (which awaits) and
    /// before the command, which can sync meeting text. The recheck needs an app handle, so this pins its place.
    #[test]
    fn terra_gate_mutate_rechecks_after_identity() {
        let source = include_str!("assistie.rs");
        let body = &source[source.find("\nasync fn mutate(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let identity = body.find(r#"raw(&bridge, "identity""#).unwrap();
        let recheck = body.find("permitted(gate, terra_enabled(&app))?;").unwrap();
        let command = body.find("snapshot(&bridge, command").unwrap();
        assert!(identity < recheck && recheck < command);
    }
}
