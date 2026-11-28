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

/// Starts the plugin unless one runs: `read_key` fetches the tunnel key, `start` spawns the supervisor without
/// it, and `give_key` hands it over. `allowed` is the Experimental switch (Terra is experimental). Everything runs
/// under the runtime lock the switch-off shutdown takes. The switch is checked before the Keychain read, again
/// after it (the read can wait on a prompt for as long as nobody answers), and once more after the spawn, so a
/// supervisor that may not run never holds the key.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) fn launch_with(
    runtime: &PluginRuntime,
    allowed: impl Fn() -> bool,
    read_key: impl FnOnce() -> Result<Vec<u8>, String>,
    start: impl FnOnce() -> Result<Child, String>,
    give_key: impl FnOnce(&mut Child, &[u8]) -> Result<(), String>,
) -> Result<(), String> {
    let mut slot = runtime.0.lock().map_err(|_| "Plugin is busy")?;
    if !allowed() {
        return Err(super::assistie::TERRA_OFF.into());
    }
    if let Some(child) = slot.as_mut() {
        if child
            .try_wait()
            .map_err(|_| "Cannot check plugin")?
            .is_none()
        {
            return Ok(());
        }
    }
    let key = read_key()?;
    if !allowed() {
        return Err(super::assistie::TERRA_OFF.into());
    }
    let mut child = start()?;
    // The switch can be saved as off while the supervisor is prepared and spawned; saving does not take this
    // lock, but the cleanup's shutdown does, so it runs after this and stops anything published here.
    let refused = if allowed() {
        give_key(&mut child, &key).err()
    } else {
        Some(super::assistie::TERRA_OFF.to_string())
    };
    if let Some(error) = refused {
        // It never got the key, so it has opened no tunnel and is only waiting on its input.
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    *slot = Some(child);
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch(app: &AppHandle) -> Result<(), String> {
    let runtime = app
        .try_state::<PluginRuntime>()
        .ok_or("Plugin unavailable")?;
    launch_with(
        &runtime,
        || super::assistie::terra_enabled(app),
        || {
            security_framework::passwords::get_generic_password(SERVICE, ACCOUNT)
                .map_err(|_| "Add a dedicated tunnel runtime key to connect".to_string())
        },
        || start_supervisor(app),
        give_key,
    )
}

#[cfg(target_os = "macos")]
fn start_supervisor(app: &AppHandle) -> Result<Child, String> {
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
    // The supervisor reads its key from stdin before it starts the tunnel; `give_key` sends it.
    Command::new("/usr/bin/python3")
        .process_group(0)
        .args(["-I", "-B"])
        .arg(script)
        .arg(root)
        .arg(binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Cannot start private plugin".to_string())
}

#[cfg(target_os = "macos")]
fn give_key(child: &mut Child, key: &[u8]) -> Result<(), String> {
    let input = child.stdin.as_mut().ok_or("Missing private input")?;
    let text = std::str::from_utf8(key).map_err(|_| "Invalid runtime key")?;
    let mut data = serde_json::to_vec(&json!({"key":text})).map_err(|_| "Invalid runtime key")?;
    data.push(b'\n');
    // A small pipe write: it does not block.
    input
        .write_all(&data)
        .map_err(|_| "Cannot start private plugin".to_string())
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
    if !super::assistie::terra_enabled(&app) {
        return Err(super::assistie::TERRA_OFF.into());
    }
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    use std::time::Duration;

    /// A stand-in supervisor: a process that runs until it is killed.
    fn sleeper() -> Result<Child, String> {
        Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())
    }

    fn no_key(_: &mut Child, _: &[u8]) -> Result<(), String> {
        Ok(())
    }

    fn reap(runtime: &PluginRuntime) {
        if let Some(mut child) = runtime.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Terra gate row 1: with the Experimental switch off, a launch (the saved-key resume at startup, a start or a
    /// connect) reads no key and spawns nothing.
    #[test]
    fn terra_gate_row1_switch_off_launches_nothing() {
        let runtime = PluginRuntime::new();
        let read = std::cell::Cell::new(false);
        let result = launch_with(
            &runtime,
            || false,
            || {
                read.set(true);
                Ok(b"sk-fictional".to_vec())
            },
            || panic!("spawned a supervisor while Terra is off"),
            no_key,
        );
        assert_eq!(result, Err(super::super::assistie::TERRA_OFF.to_string()));
        assert!(!read.get(), "read the Keychain while Terra is off");
        assert!(runtime.0.lock().unwrap().is_none());
    }

    /// Terra gate row 2: switch on, key saved: the supervisor starts as before and gets its key.
    #[test]
    fn terra_gate_row2_switch_on_launches_as_before() {
        let runtime = PluginRuntime::new();
        let handed = std::cell::Cell::new(false);
        let result = launch_with(
            &runtime,
            || true,
            || Ok(b"sk-fictional".to_vec()),
            sleeper,
            |_, key| {
                handed.set(key == b"sk-fictional");
                Ok(())
            },
        );
        assert_eq!(result, Ok(()));
        assert!(handed.get(), "the published supervisor never got its key");
        assert!(
            runtime.0.lock().unwrap().is_some(),
            "no supervisor published"
        );
        reap(&runtime);
    }

    /// Terra gate row 7: the switch goes off while a launch waits on the Keychain prompt. When the read returns,
    /// nothing is spawned.
    #[test]
    fn terra_gate_switch_off_during_a_blocked_keychain_read_spawns_nothing() {
        let runtime = Arc::new(PluginRuntime::new());
        let on = Arc::new(AtomicBool::new(true));
        let spawned = Arc::new(AtomicBool::new(false));
        let (entered, reading) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let launcher = {
            let (runtime, on, spawned) = (runtime.clone(), on.clone(), spawned.clone());
            std::thread::spawn(move || {
                launch_with(
                    &runtime,
                    move || on.load(Ordering::Acquire),
                    move || {
                        entered.send(()).unwrap();
                        let _ = released.recv();
                        Ok(b"sk-fictional".to_vec())
                    },
                    move || {
                        spawned.store(true, Ordering::Release);
                        sleeper()
                    },
                    no_key,
                )
            })
        };
        reading.recv_timeout(Duration::from_secs(5)).unwrap();
        on.store(false, Ordering::Release); // the switch is saved as off while the prompt is up
        release.send(()).unwrap();
        let result = launcher.join().unwrap();
        assert!(
            !spawned.load(Ordering::Acquire),
            "spawned a supervisor after the switch went off"
        );
        assert_eq!(result, Err(super::super::assistie::TERRA_OFF.to_string()));
        runtime.shutdown(); // the cleanup's step, after the launch let go of the lock
        assert!(runtime.0.lock().unwrap().is_none());
    }

    /// Terra gate row 7b: the switch goes off after both checks passed, while the supervisor is being spawned. It
    /// never gets the key and is stopped, not published.
    #[test]
    fn terra_gate_switch_off_during_the_spawn_never_publishes() {
        let runtime = PluginRuntime::new();
        let checks = std::cell::Cell::new(0);
        let result = launch_with(
            &runtime,
            || {
                checks.set(checks.get() + 1);
                checks.get() <= 2 // on for the two checks before the spawn, off after it
            },
            || Ok(b"sk-fictional".to_vec()),
            sleeper,
            |_, _| panic!("handed the key to a supervisor after the switch went off"),
        );
        assert_eq!(
            checks.get(),
            3,
            "the switch was not checked after the spawn"
        );
        assert_eq!(result, Err(super::super::assistie::TERRA_OFF.to_string()));
        assert!(
            runtime.0.lock().unwrap().is_none(),
            "published a supervisor after the switch went off"
        );
    }
}
