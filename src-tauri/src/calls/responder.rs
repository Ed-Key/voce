//! Local Terra responder: one warm codex session per consented meeting, on the user's ChatGPT plan.
//! The process talks to the meeting only through bridge.py and exits when sharing ends or when
//! its stdin closes (Handy quit or was killed), reaping its codex child itself. It starts nothing until Handy
//! writes "go" on that stdin, after its last check that Terra (experimental) is still allowed.
use std::{
    io::Write,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const SCRIPT: &str = include_str!("../../resources/assistie/responder.py");

pub struct TerraRuntime(Mutex<Option<Child>>);

impl TerraRuntime {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn shutdown(&self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(child) = slot.take() {
                stop(child);
            }
        }
    }
}

/// Whether a responder process is alive; a mark is refused when it is not.
pub(super) fn running(app: &AppHandle) -> bool {
    app.try_state::<TerraRuntime>()
        .and_then(|runtime| {
            let mut slot = runtime.0.lock().ok()?;
            let child = slot.as_mut()?;
            Some(matches!(child.try_wait(), Ok(None)))
        })
        .unwrap_or(false)
}

impl Drop for TerraRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn stop(mut child: Child) {
    // EOF lets the responder kill and reap codex; the group kill covers a stuck responder.
    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().ok().flatten().is_none() {
        if Instant::now() >= deadline {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.wait();
}

#[cfg(target_os = "macos")]
pub(super) fn launch(app: &AppHandle, run_id: &str, connection_id: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::process::CommandExt;
    let runtime = app
        .try_state::<TerraRuntime>()
        .ok_or("Terra route unavailable")?;
    let mut slot = runtime.0.lock().map_err(|_| "Terra route is busy")?;
    // Terra is experimental. Checked here as well as by the caller, under the lock the switch-off shutdown takes:
    // the switch can go off while this launch waits for the lock, and once more after the spawn below.
    if !super::assistie::terra_enabled(app) {
        return Err(super::assistie::TERRA_OFF.into());
    }
    // One meeting at a time: an older responder's run is no longer active, so end it now.
    if let Some(previous) = slot.take() {
        stop(previous);
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("assistie");
    super::assistie::prepare(&root)?;
    let script = root.join("responder.py");
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&script)
        .and_then(|mut file| file.write_all(SCRIPT.as_bytes()))
        .map_err(|_| "Cannot prepare the Terra route")?;
    let mut child = Command::new("/usr/bin/python3")
        .process_group(0)
        .args(["-I", "-B"])
        .arg(&script)
        .arg(&root)
        .arg(run_id)
        .arg(connection_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Cannot start the Terra route")?;
    // The responder reads nothing and starts no codex until it gets "go", written only after this last check,
    // still under the lock. Saving the switch does not take the lock, but the cleanup's shutdown does, so it
    // runs after this and stops anything published here. A three-byte pipe write: it does not block.
    let go = if super::assistie::terra_enabled(app) {
        child
            .stdin
            .as_mut()
            .ok_or("Missing Terra input")
            .and_then(|input| {
                input
                    .write_all(b"go\n")
                    .map_err(|_| "Cannot start the Terra route")
            })
            .map_err(String::from)
    } else {
        Err(super::assistie::TERRA_OFF.to_string())
    };
    if let Err(error) = go {
        // It never got its go, so it has started nothing: closing its input makes it exit at once.
        stop(child);
        return Err(error);
    }
    *slot = Some(child);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn launch(_: &AppHandle, _: &str, _: &str) -> Result<(), String> {
    Err("The Terra route requires macOS".into())
}
