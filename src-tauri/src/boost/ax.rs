// The Accessibility helpers and the app checks are ported from SpeakoFlow
// (https://github.com/AbhishekBarali/SpeakoFlow,
// src-tauri/src/smart_spacing/macos.rs at 5a79218), MIT License,
// Copyright (c) 2026 Abhishek Barali, Copyright (c) 2025 CJ Pais.
// See LICENSE-SpeakoFlow in this directory. The window walk is Voce's own.

//! macOS: the text of the frontmost app's focused window, for the boost list
//! builder (boost rows 15 and 16).
//!
//! Every AX call is a synchronous message answered by the target app's main
//! thread, so all of them run on one dedicated thread with short messaging
//! timeouts. Never on our main thread: a stalled AX call there would freeze
//! the app, and asking our own windows would wait on ourselves.
//!
//! * Needs the Accessibility permission Voce already has to paste; without it
//!   nothing is read.
//! * Secure input (a password prompt anywhere) and secure text fields are
//!   never read.
//! * Chromium browsers and Electron apps only build their accessibility tree
//!   when asked. `AXManualAccessibility` is switched on for them and left on
//!   when they come to the front (`warm`), since a cold tree takes about 2 s
//!   to answer. `AXEnhancedUserInterface` is never written: it flips an app
//!   into screen-reader mode for the rest of its life. Terminals are never
//!   switched on.
//! * A text element gives only a window around its caret (`AXStringForRange`),
//!   never a whole document.
//! * Only counts and reasons are logged, never window text.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use log::debug;
use objc2_application_services::{AXError, AXIsProcessTrusted, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{CFArray, CFBoolean, CFNumber, CFRange, CFRetained, CFString, CFType};

/// Messaging timeout for the warm-up's AX calls, in seconds.
const AX_TIMEOUT_SECS: f32 = 0.2;

enum Job {
    /// An app came to the front: switch its tree on if it builds it lazily.
    Warm { pid: i32 },
    /// The text of `pid`'s focused window, nearest the focused element first.
    Walk {
        pid: i32,
        reply: SyncSender<WindowTexts>,
    },
}

/// What a bounded window walk read: text pieces with their
/// distance from the focused element, and why the walk ended.
#[derive(Debug, Clone, Default)]
pub struct WindowTexts {
    pub title: String,
    pub texts: Vec<(String, u32)>,
    pub nodes: usize,
    pub ms: u128,
    pub reason: &'static str,
}

/// Walk caps: time and nodes.
const WALK_BUDGET: Duration = Duration::from_millis(50);
const WALK_MAX_NODES: usize = 300;
const WALK_MAX_DEPTH: usize = 24;
/// Per-call messaging timeout during a walk, so one slow app call cannot
/// blow the 50 ms cap by much.
const WALK_AX_TIMEOUT_SECS: f32 = 0.05;
/// Longest text taken from one element.
const WALK_MAX_TEXT: usize = 2000;

static JOBS: OnceLock<Mutex<Option<Sender<Job>>>> = OnceLock::new();

fn jobs() -> Option<Sender<Job>> {
    let slot = JOBS.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        let spawned = std::thread::Builder::new()
            .name("boost-ax".into())
            .spawn(move || worker(rx));
        Mutex::new(spawned.ok().map(|_| tx))
    });
    slot.lock().ok().and_then(|guard| guard.clone())
}

/// Walk `pid`'s focused window on the walker thread (never the main thread).
/// None if the worker is down or too slow.
pub fn walk(pid: i32) -> Option<WindowTexts> {
    let sender = jobs()?;
    let (reply, answer) = mpsc::sync_channel(1);
    sender.send(Job::Walk { pid, reply }).ok()?;
    // The walk caps itself at 50 ms; a queued warm-up may run first.
    answer.recv_timeout(Duration::from_secs(2)).ok()
}

/// Ask the walker thread to switch on `pid`'s accessibility tree if it is
/// a Chromium or Electron app, so the tree is built before the user
/// dictates (Claude's takes about 2 s). Returns at once.
pub fn warm(pid: i32) {
    if let Some(sender) = jobs() {
        let _ = sender.send(Job::Warm { pid });
    }
}

/// Whether an activated app gets its tree switched on: Chromium or Electron
/// apps only, never a terminal and never Voce itself.
fn should_warm(pid: i32, own_pid: i32, name: &str, web_app: bool) -> bool {
    pid > 0 && pid != own_pid && web_app && !is_terminal(name)
}

fn warm_app(pid: i32) {
    if !unsafe { AXIsProcessTrusted() } {
        return;
    }
    let bundle = app_bundle_path(pid).unwrap_or_default();
    let name = bundle_name(&bundle);
    let web_app = builds_tree_on_request(&bundle, &name);
    if !should_warm(pid, std::process::id() as i32, &name, web_app) {
        return;
    }
    let app = unsafe { AXUIElement::new_application(pid) };
    set_timeout(&app);
    // Some apps (Claude) read the flag back as false while it is on; setting
    // it again is harmless.
    if attr_bool(&app, "AXManualAccessibility") != Some(true) {
        // Chrome refuses the write (its tree comes on when a client asks),
        // so a failure is expected and only noted at debug level.
        let ok = set_manual_accessibility(&app, true);
        debug!("Boost list: switched on the accessibility tree of {name} on activation (ok={ok})");
    }
}

fn worker(jobs: Receiver<Job>) {
    loop {
        match jobs.recv_timeout(Duration::from_secs(10)) {
            Ok(Job::Warm { pid }) => {
                let _ = std::panic::catch_unwind(|| objc2::rc::autoreleasepool(|_| warm_app(pid)));
            }
            Ok(Job::Walk { pid, reply }) => {
                let started = Instant::now();
                let mut out = std::panic::catch_unwind(|| {
                    objc2::rc::autoreleasepool(|_| walk_window(pid, started))
                })
                .unwrap_or(WindowTexts {
                    reason: "worker_panic",
                    ..Default::default()
                });
                out.ms = started.elapsed().as_millis();
                // Counts and reasons only, never window text.
                debug!(
                    "Boost list: walked {} nodes in {} ms, {} texts (reason={})",
                    out.nodes,
                    out.ms,
                    out.texts.len(),
                    out.reason
                );
                let _ = reply.try_send(out);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/* ───────────────────────────── AX helpers ───────────────────────────── */

fn attr(element: &AXUIElement, name: &str) -> Result<CFRetained<CFType>, AXError> {
    let name = CFString::from_str(name);
    let mut value: *const CFType = std::ptr::null();
    let error = unsafe { element.copy_attribute_value(&name, NonNull::from(&mut value)) };
    if error != AXError::Success {
        return Err(error);
    }
    NonNull::new(value as *mut CFType)
        .map(|ptr| unsafe { CFRetained::from_raw(ptr) })
        .ok_or(AXError::NoValue)
}

fn attr_string(element: &AXUIElement, name: &str) -> Option<String> {
    let value = attr(element, name).ok()?;
    value.downcast_ref::<CFString>().map(|s| s.to_string())
}

fn attr_bool(element: &AXUIElement, name: &str) -> Option<bool> {
    let value = attr(element, name).ok()?;
    value.downcast_ref::<CFBoolean>().map(|b| b.as_bool())
}

fn attr_isize(element: &AXUIElement, name: &str) -> Option<isize> {
    let value = attr(element, name).ok()?;
    value
        .downcast_ref::<CFNumber>()
        .and_then(|n| n.as_i64())
        .map(|n| n as isize)
}

fn attr_range(element: &AXUIElement, name: &str) -> Option<CFRange> {
    let value = attr(element, name).ok()?;
    let value = value.downcast_ref::<AXValue>()?;
    let mut range = CFRange {
        location: 0,
        length: 0,
    };
    let ok = unsafe {
        value.value(
            AXValueType::CFRange,
            NonNull::from(&mut range).cast::<c_void>(),
        )
    };
    ok.then_some(range)
}

/// The text in `range`. `short_ok` accepts a shorter answer: with no
/// character count the range may run past the end, and Chromium clamps it.
fn string_for_range(element: &AXUIElement, range: CFRange, short_ok: bool) -> Option<Vec<u16>> {
    let name = CFString::from_str("AXStringForRange");
    let parameter =
        unsafe { AXValue::new(AXValueType::CFRange, NonNull::from(&range).cast::<c_void>()) }?;
    let mut value: *const CFType = std::ptr::null();
    let error = unsafe {
        element.copy_parameterized_attribute_value(
            &name,
            parameter.as_ref(),
            NonNull::from(&mut value),
        )
    };
    if error != AXError::Success {
        return None;
    }
    let value = unsafe { CFRetained::from_raw(NonNull::new(value as *mut CFType)?) };
    let text = value.downcast_ref::<CFString>()?.to_string();
    let units: Vec<u16> = text.encode_utf16().collect();
    // An app that answers with a different length than asked is not trusted.
    range_answer_ok(units.len(), range.length, short_ok).then_some(units)
}

fn range_answer_ok(got: usize, asked: isize, short_ok: bool) -> bool {
    got as isize == asked || (short_ok && (got as isize) < asked)
}

fn set_timeout(element: &AXUIElement) {
    unsafe {
        let _ = element.set_messaging_timeout(AX_TIMEOUT_SECS);
    }
}

/// Whether the app accepted the change.
fn set_manual_accessibility(app: &AXUIElement, on: bool) -> bool {
    let name = CFString::from_str("AXManualAccessibility");
    let value: &CFType = CFBoolean::new(on).as_ref();
    unsafe { app.set_attribute_value(&name, value) == AXError::Success }
}

/* ───────────────────────────── boost walk ───────────────────────────── */

/// An element attribute, with the walk's short timeout set on the element
/// it returns, so every later call on it is bounded too.
fn attr_element(element: &AXUIElement, name: &str) -> Option<CFRetained<AXUIElement>> {
    let el = attr(element, name).ok()?.downcast::<AXUIElement>().ok()?;
    walk_timeout(&el);
    Some(el)
}

fn walk_timeout(element: &AXUIElement) {
    unsafe {
        let _ = element.set_messaging_timeout(WALK_AX_TIMEOUT_SECS);
    }
}

/// Before each request on `element`: false once the walk's budget is
/// spent; otherwise the request may take at most what is left (and never
/// more than the per-call cap).
fn within_budget(element: &AXUIElement, deadline: Instant) -> bool {
    let left = deadline
        .saturating_duration_since(Instant::now())
        .as_secs_f32();
    if left <= 0.0 {
        return false;
    }
    unsafe {
        let _ = element.set_messaging_timeout(left.min(WALK_AX_TIMEOUT_SECS));
    }
    true
}

fn children(element: &AXUIElement) -> Vec<CFRetained<AXUIElement>> {
    let Ok(value) = attr(element, "AXChildren") else {
        return Vec::new();
    };
    let Ok(array) = value.downcast::<CFArray>() else {
        return Vec::new();
    };
    // SAFETY: AXChildren is an array of AXUIElements; each item is still
    // checked by downcast before use.
    let array: CFRetained<CFArray<CFType>> = unsafe { CFRetained::cast_unchecked(array) };
    array
        .iter()
        .filter_map(|c| c.downcast::<AXUIElement>().ok())
        .inspect(|c| walk_timeout(c))
        .collect()
}

/// Interface parts whose text is never names.
fn walk_pruned(role: &str) -> bool {
    matches!(
        role,
        "AXMenuBar"
            | "AXMenu"
            | "AXMenuItem"
            | "AXToolbar"
            | "AXButton"
            | "AXMenuButton"
            | "AXPopUpButton"
            | "AXImage"
            | "AXScrollBar"
            | "AXCheckBox"
            | "AXRadioButton"
    )
}

/// The visible text of one element, if it is a kind that holds text. A
/// text field or area gives the text around its caret (a long document's
/// head would push the nearest names out), else its value's start.
fn element_text(el: &AXUIElement, role: &str, deadline: Instant) -> Option<String> {
    let text = match role {
        // A text area may hold a long document: without a ranged read
        // around the caret its header would stand in for the caret's text.
        "AXTextArea" => around_caret(el, deadline),
        "AXTextField" => around_caret(el, deadline)
            .or_else(|| {
                within_budget(el, deadline)
                    .then(|| attr_string(el, "AXValue"))
                    .flatten()
            })
            .or_else(|| {
                within_budget(el, deadline)
                    .then(|| attr_string(el, "AXTitle"))
                    .flatten()
            }),
        "AXStaticText" | "AXCell" => first_text(el, &["AXValue", "AXTitle"], deadline),
        "AXHeading" | "AXLink" | "AXRow" | "AXTab" => {
            first_text(el, &["AXTitle", "AXDescription", "AXValue"], deadline)
        }
        _ => None,
    }?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(WALK_MAX_TEXT).collect())
}

/// The first non-empty of `names`, each request within the walk's budget.
fn first_text(el: &AXUIElement, names: &[&str], deadline: Instant) -> Option<String> {
    names.iter().find_map(|name| {
        within_budget(el, deadline)
            .then(|| attr_string(el, name))
            .flatten()
            .filter(|t| !t.is_empty())
    })
}

/// About WALK_MAX_TEXT characters of a text element centred a little before
/// its caret, read with a ranged request (never the whole document).
fn around_caret(el: &AXUIElement, deadline: Instant) -> Option<String> {
    let sel = attr_range(el, "AXSelectedTextRange")?;
    if !within_budget(el, deadline) {
        return None;
    }
    let count = attr_isize(el, "AXNumberOfCharacters");
    if !within_budget(el, deadline) {
        return None;
    }
    let before = (WALK_MAX_TEXT * 3 / 4) as isize;
    let location = (sel.location - before).max(0);
    let mut length = WALK_MAX_TEXT as isize;
    if let Some(n) = count {
        length = length.min((n - location).max(0));
    }
    let units = string_for_range(el, CFRange { location, length }, count.is_none())?;
    Some(String::from_utf16_lossy(&units))
}

/// Outward from the focused element: its own subtree first (distance 0),
/// then each ancestor's other children (distance 1, 2, ...), within the
/// time and node caps.
fn walk_window(pid: i32, started: Instant) -> WindowTexts {
    let mut out = WindowTexts::default();
    if !unsafe { AXIsProcessTrusted() } {
        out.reason = "not_trusted";
        return out;
    }
    if crate::secure_input::is_enabled_now() {
        out.reason = "secure_input";
        return out;
    }
    let deadline = started + WALK_BUDGET;
    let app = unsafe { AXUIElement::new_application(pid) };
    walk_timeout(&app);
    let Some(window) = within_budget(&app, deadline)
        .then(|| attr_element(&app, "AXFocusedWindow"))
        .flatten()
        .or_else(|| {
            within_budget(&app, deadline)
                .then(|| attr_element(&app, "AXMainWindow"))
                .flatten()
        })
    else {
        out.reason = "no_window";
        return out;
    };
    out.title = within_budget(&window, deadline)
        .then(|| attr_string(&window, "AXTitle"))
        .flatten()
        .unwrap_or_default();
    let focused = within_budget(&app, deadline)
        .then(|| attr_element(&app, "AXFocusedUIElement"))
        .flatten();
    // A focused secure field: no screen names for this window at all. A
    // native or web password field also turns on Secure Event Input, which
    // stops the walk above; this catches the rest. Focus that cannot be read
    // (common in Chromium) is not taken to be secure.
    if focused.as_ref().is_some_and(|f| {
        within_budget(f, deadline)
            && attr_string(f, "AXSubrole").as_deref() == Some("AXSecureTextField")
    }) {
        out.reason = "secure_field";
        return out;
    }
    // The focused element and its ancestors up to the window.
    let mut chain: Vec<CFRetained<AXUIElement>> = Vec::new();
    if let Some(f) = focused {
        let mut cur = Some(f);
        while let Some(el) = cur {
            let at_window = *el == *window;
            chain.push(el.clone());
            if at_window || chain.len() > WALK_MAX_DEPTH || Instant::now() >= deadline {
                break;
            }
            cur = within_budget(&el, deadline)
                .then(|| attr_element(&el, "AXParent"))
                .flatten();
        }
    }
    if chain.last().is_none_or(|el| **el != *window) {
        chain.push(window.clone());
    }
    if !out.title.is_empty() {
        out.texts.push((out.title.clone(), chain.len() as u32));
    }
    out.reason = "done";
    for (distance, root) in chain.iter().enumerate() {
        let skip = distance.checked_sub(1).map(|i| &chain[i]);
        let mut stack = vec![(root.clone(), 0usize)];
        while let Some((el, depth)) = stack.pop() {
            if out.nodes >= WALK_MAX_NODES {
                out.reason = "node_cap";
                return out;
            }
            if Instant::now() >= deadline {
                out.reason = "time_cap";
                return out;
            }
            out.nodes += 1;
            if !within_budget(&el, deadline) {
                out.reason = "time_cap";
                return out;
            }
            let role = attr_string(&el, "AXRole").unwrap_or_default();
            if !within_budget(&el, deadline) {
                out.reason = "time_cap";
                return out;
            }
            if attr_string(&el, "AXSubrole").as_deref() == Some("AXSecureTextField") {
                continue;
            }
            if !within_budget(&el, deadline) {
                out.reason = "time_cap";
                return out;
            }
            if let Some(text) = element_text(&el, &role, deadline) {
                out.texts.push((text, distance as u32));
            }
            if depth >= WALK_MAX_DEPTH || walk_pruned(&role) || role == "AXStaticText" {
                continue;
            }
            if !within_budget(&el, deadline) {
                out.reason = "time_cap";
                return out;
            }
            for child in children(&el).into_iter().rev() {
                if skip.is_some_and(|s| **s == *child) {
                    continue; // already walked at a smaller distance
                }
                stack.push((child, depth + 1));
            }
        }
    }
    out
}

/* ───────────────────────────── the app ───────────────────────────── */

fn app_bundle_path(pid: i32) -> Option<String> {
    let mut buffer = vec![0u8; 4096];
    let len =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr() as *mut c_void, buffer.len() as u32) };
    if len <= 0 {
        return None;
    }
    let path = String::from_utf8_lossy(&buffer[..len as usize]).into_owned();
    // ".../Foo.app/Contents/MacOS/Foo" -> ".../Foo.app"
    let end = path.find(".app/").map(|i| i + 4)?;
    Some(path[..end].to_string())
}

fn bundle_name(bundle: &str) -> String {
    bundle
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim_end_matches(".app")
        .to_ascii_lowercase()
}

fn is_terminal(name: &str) -> bool {
    matches!(
        name,
        "terminal"
            | "iterm"
            | "iterm2"
            | "warp"
            | "ghostty"
            | "kitty"
            | "alacritty"
            | "wezterm"
            | "hyper"
            | "tabby"
            | "cmux"
    )
}

/// Apps that only build their accessibility tree on request.
fn builds_tree_on_request(bundle: &str, name: &str) -> bool {
    let chromium = matches!(
        name,
        "google chrome"
            | "google chrome beta"
            | "google chrome canary"
            | "chromium"
            | "arc"
            | "brave browser"
            | "microsoft edge"
            | "vivaldi"
            | "opera"
            | "dia"
            | "comet"
    );
    chromium
        || std::path::Path::new(bundle)
            .join("Contents/Frameworks/Electron Framework.framework")
            .exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_warms_only_chromium_and_electron_apps() {
        let me = 100;
        assert!(should_warm(42, me, "claude", true), "Electron app");
        assert!(!should_warm(42, me, "textedit", false), "native app");
        assert!(
            !should_warm(42, me, "hyper", true),
            "terminal, even on Electron"
        );
        assert!(!should_warm(me, me, "voce", true), "Voce itself");
        assert!(!should_warm(0, me, "claude", true), "no pid");
    }

    #[test]
    fn a_clamped_range_answer_is_accepted_only_without_a_count() {
        assert!(range_answer_ok(10, 10, false));
        assert!(!range_answer_ok(7, 10, false));
        assert!(range_answer_ok(7, 10, true));
        assert!(!range_answer_ok(11, 10, true));
    }
}
