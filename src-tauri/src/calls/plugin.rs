//! Private consented plugin pairing, isolated from dictation settings and audio.
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

// Keychain service name of the saved tunnel key. Kept from the app's earlier
// identifier on purpose: renaming it would orphan the saved key.
const SERVICE: &str = "com.edkiboma.handy.calls.dev.assistie-plugin";
const ACCOUNT: &str = "tunnel-runtime";
const SCRIPT: &str = include_str!("../../resources/assistie/plugin.py");
pub struct PluginRuntime(Mutex<Option<Child>>);
#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
pub struct PluginStatus {
    phase: String,
    running: bool,
    fictional_only: bool,
    installation_id: Option<String>,
    subscriptions: Option<u32>,
}
impl PluginRuntime {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
    pub fn shutdown(&self) {
        if let Ok(mut slot) = self.0.lock() {
            // EOF lets the supervisor terminate its tunnel child and close listeners.
            if let Some(mut child) = slot.take() {
                drop(child.stdin.take());
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
                while child.try_wait().ok().flatten().is_none() {
                    if std::time::Instant::now() >= deadline {
                        #[cfg(unix)]
                        unsafe {
                            libc::kill(-(child.id() as i32), libc::SIGKILL);
                        }
                        let _ = child.kill();
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                let _ = child.wait();
            }
        }
    }
}
impl Drop for PluginRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// Only a saved, explicitly configured dev credential opts into reconnecting.
pub fn resume_saved(app: &AppHandle) {
    if app.config().identifier == crate::APP_ID {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = launch(&handle);
        });
    }
}

fn root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if app.config().identifier != crate::APP_ID {
        return Err("Plugin requires Voce".into());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("assistie"))
}

#[cfg(target_os = "macos")]
fn launch(app: &AppHandle) -> Result<(), String> {
    let runtime = app
        .try_state::<PluginRuntime>()
        .ok_or("Plugin unavailable")?;
    let mut slot = runtime.0.lock().map_err(|_| "Plugin is busy")?;
    if let Some(child) = slot.as_mut() {
        if child
            .try_wait()
            .map_err(|_| "Cannot check plugin")?
            .is_none()
        {
            return Ok(());
        }
    }
    let key = security_framework::passwords::get_generic_password(SERVICE, ACCOUNT)
        .map_err(|_| "Add a dedicated tunnel runtime key to connect")?;
    let root = root(app)?;
    super::assistie::prepare(&root)?;
    let script = root.join("plugin.py");
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&script)
            .map_err(|_| "Cannot prepare plugin")?;
        file.write_all(SCRIPT.as_bytes())
            .map_err(|_| "Cannot prepare plugin")?;
    }
    let binary = app
        .path()
        .resource_dir()
        .map_err(|_| "Missing resources")?
        .join("resources/assistie/bin/tunnel-client");
    if !binary.is_file() {
        return Err("Tunnel runtime is missing from the dev bundle".into());
    }
    use std::os::unix::process::CommandExt;
    let mut child = Command::new("/usr/bin/python3")
        .process_group(0)
        .args(["-I", "-B"])
        .arg(script)
        .arg(root)
        .arg(binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Cannot start private plugin")?;
    let result = child
        .stdin
        .as_mut()
        .ok_or("Missing private input")
        .and_then(|input| {
            let text = std::str::from_utf8(&key).map_err(|_| "Invalid runtime key")?;
            let mut data =
                serde_json::to_vec(&json!({"key":text})).map_err(|_| "Invalid runtime key")?;
            data.push(b'\n');
            input
                .write_all(&data)
                .map_err(|_| "Cannot start private plugin")
        });
    if let Err(error) = result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.into());
    }
    *slot = Some(child);
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn launch(_: &AppHandle) -> Result<(), String> {
    Err("This private plugin test requires macOS".into())
}

#[tauri::command]
#[specta::specta]
pub async fn assistie_plugin_status(app: AppHandle) -> Result<PluginStatus, String> {
    let root = root(&app)?;
    let running = if let Some(runtime) = app.try_state::<PluginRuntime>() {
        let mut slot = runtime.0.lock().map_err(|_| "Plugin busy")?;
        slot.as_mut()
            .map(|p| matches!(p.try_wait(), Ok(None)))
            .unwrap_or(false)
    } else {
        false
    };
    let path = root.join("plugin/status.json");
    if path.is_symlink() {
        return Err("Plugin status unavailable".into());
    }
    let mut status: Value = std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(json!({"phase":"offline","fictional_only":false}));
    if let Some(error) = status["error"].as_str() {
        return Err(error.to_string());
    }
    let age = chrono::Utc::now().timestamp() as f64 - status["at"].as_f64().unwrap_or(0.0);
    if !running || age > 25.0 {
        status["phase"] = json!("offline");
    }
    status["running"] = json!(running);
    serde_json::from_value(status).map_err(|_| "Plugin status unavailable".into())
}

#[tauri::command]
#[specta::specta]
pub async fn configure_assistie_plugin(app: AppHandle, key: String) -> Result<(), String> {
    root(&app)?;
    if !key.starts_with("sk-") || key.len() > 512 || key.chars().any(char::is_whitespace) {
        return Err("Use a dedicated runtime key with Tunnels Read and Use only".into());
    }
    #[cfg(target_os = "macos")]
    security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, key.as_bytes())
        .map_err(|_| "Cannot save the runtime key in Mac Keychain")?;
    if let Some(runtime) = app.try_state::<PluginRuntime>() {
        runtime.shutdown();
    }
    launch(&app)
}

#[tauri::command]
#[specta::specta]
pub async fn start_assistie_plugin(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || launch(&app))
        .await
        .map_err(|_| "Cannot start the private plugin".to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn disconnect_assistie_plugin(app: AppHandle) -> Result<(), String> {
    root(&app)?;
    if let Some(runtime) = app.try_state::<PluginRuntime>() {
        runtime.shutdown();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT);
    }
    // The supervisor's EOF disables delivery. Keep pairing metadata for inspection;
    // Deleting the credential also prevents automatic reconnection on relaunch.
    Ok(())
}

// Select the route only at fresh consent. Existing meetings never switch workers.
pub async fn ready_for_meetings(app: &AppHandle) -> bool {
    assistie_plugin_status(app.clone())
        .await
        .map(|s| {
            s.running
                && s.subscriptions.unwrap_or(0) > 0
                && matches!(
                    s.phase.as_str(),
                    "paired" | "connecting" | "connected" | "delayed" | "starting_worker"
                )
        })
        .unwrap_or(false)
}
