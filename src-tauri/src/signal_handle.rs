use crate::TranscriptionCoordinator;
#[cfg(unix)]
use log::debug;
use log::warn;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use signal_hook::consts::SIGUSR1;
#[cfg(unix)]
use signal_hook::consts::SIGUSR2;
#[cfg(unix)]
use signal_hook::iterator::Signals;
#[cfg(unix)]
use std::thread;

/// The binding the external "with cleanup" triggers (macOS SIGUSR1 and
/// `--toggle-post-process`) dispatch. They used to name the second shortcut's
/// id, `transcribe_with_post_process`, but since settings schema 3 that id
/// pastes raw and the main key cleans when cleanup is on (row C1). Automation
/// asking for cleaned text keeps getting it, so these go to the main key.
pub const CLEANUP_TRIGGER_BINDING: &str = "transcribe";

/// The binding a remote-control CLI flag sent to the running instance toggles.
pub fn cli_binding(args: &[String]) -> Option<&'static str> {
    if args.iter().any(|a| a == "--toggle-transcription") {
        Some("transcribe")
    } else if args.iter().any(|a| a == "--toggle-post-process") {
        Some(CLEANUP_TRIGGER_BINDING)
    } else {
        None
    }
}

/// The binding and log name for a transcription signal.
#[cfg(unix)]
pub fn signal_binding(sig: i32) -> Option<(&'static str, &'static str)> {
    match sig {
        #[cfg(target_os = "macos")]
        SIGUSR1 => Some((CLEANUP_TRIGGER_BINDING, "SIGUSR1")),
        SIGUSR2 => Some(("transcribe", "SIGUSR2")),
        _ => None,
    }
}

/// Send a transcription input to the coordinator.
/// Used by signal handlers, CLI flags, and any other external trigger.
pub fn send_transcription_input(app: &AppHandle, binding_id: &str, source: &str) {
    if let Some(c) = app.try_state::<TranscriptionCoordinator>() {
        c.send_external_input(binding_id, source);
    } else {
        warn!("TranscriptionCoordinator not initialized");
    }
}

/// Listen for Unix signals that remotely toggle transcription.
///
/// SIGUSR2 toggles plain transcription on all Unix platforms. SIGUSR1
/// (transcription with post-processing) is only handled on macOS: on Linux,
/// WebKitGTK's JavaScriptCore garbage collector sends SIGUSR1 to its own
/// threads to suspend them, so handling it caused phantom recordings on every
/// GC cycle (#1660). Linux users should use `handy --toggle-post-process`
/// instead.
#[cfg(unix)]
pub fn setup_signal_handler(app_handle: AppHandle) {
    #[cfg(target_os = "macos")]
    let mut signals =
        Signals::new([SIGUSR1, SIGUSR2]).expect("failed to register transcription signal handlers");
    #[cfg(not(target_os = "macos"))]
    let mut signals =
        Signals::new([SIGUSR2]).expect("failed to register transcription signal handlers");
    #[cfg(target_os = "macos")]
    debug!("Signal handlers registered (SIGUSR1, SIGUSR2)");
    #[cfg(not(target_os = "macos"))]
    debug!("Signal handler registered (SIGUSR2; SIGUSR1 is left to WebKitGTK)");
    thread::spawn(move || {
        for sig in signals.forever() {
            let Some((binding_id, signal_name)) = signal_binding(sig) else {
                continue;
            };
            debug!("Received {signal_name}");
            send_transcription_input(&app_handle, binding_id, signal_name);
        }
    });
}
