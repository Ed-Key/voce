//! The per-window name cache (boost rows 14 to 16): RAM only, keyed by app
//! and window, refreshed by a debounced walk off the main thread on app
//! activation, focus change and window-title change. Key-down reads whatever
//! is cached and never waits on a walk. Window text is never logged, kept on
//! disk or sent anywhere.

use super::list::{rank, Candidate, ScreenText};
use log::debug;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Triggers closer together than this make one walk.
pub const DEBOUNCE: Duration = Duration::from_millis(300);
/// Windows remembered.
const CACHED_WINDOWS: usize = 32;

#[derive(Default)]
pub struct Cache {
    windows: HashMap<(i32, String), Vec<Candidate>>,
    order: VecDeque<(i32, String)>,
    /// The window walked last for each app.
    current: HashMap<i32, String>,
    /// Bumped by every focus or window change per app; a walk that started
    /// before the latest change is not stored.
    focus_gen: HashMap<i32, u64>,
}

impl Cache {
    pub fn store(&mut self, pid: i32, title: String, names: Vec<Candidate>) {
        let key = (pid, title.clone());
        self.order.retain(|k| k != &key);
        self.order.push_back(key.clone());
        while self.order.len() > CACHED_WINDOWS {
            if let Some(old) = self.order.pop_front() {
                self.windows.remove(&old);
            }
        }
        self.windows.insert(key, names);
        self.current.insert(pid, title);
    }

    /// Focus or window changed in `pid`: its cached names are not used
    /// until the next walk says what is focused now (a secure field gets
    /// none). The window's entry stays for when it comes back.
    pub fn invalidate(&mut self, pid: i32) {
        self.current.remove(&pid);
        *self.focus_gen.entry(pid).or_default() += 1;
    }

    /// The focus generation a walk of `pid` starts from.
    pub fn generation(&self, pid: i32) -> u64 {
        self.focus_gen.get(&pid).copied().unwrap_or(0)
    }

    /// Store a walk's names unless focus changed since it started.
    pub fn store_walk(&mut self, pid: i32, started_gen: u64, title: String, names: Vec<Candidate>) {
        if self.generation(pid) == started_gen {
            self.store(pid, title, names);
        }
    }

    /// What is cached for `pid`'s current window; empty if nothing yet.
    pub fn for_app(&self, pid: i32) -> Vec<Candidate> {
        self.current
            .get(&pid)
            .and_then(|t| self.windows.get(&(pid, t.clone())))
            .cloned()
            .unwrap_or_default()
    }
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
static TRIGGERS: OnceLock<Mutex<Sender<i32>>> = OnceLock::new();
/// Walk only while the loaded model is one boosting applies to.
static WANTED: AtomicBool = AtomicBool::new(false);

pub fn set_wanted(on: bool) {
    WANTED.store(on, Ordering::Relaxed);
}

fn with_cache<R>(f: impl FnOnce(&mut Cache) -> R) -> R {
    let mut guard = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(Cache::default))
}

/// The focused element or window changed: drop `pid`'s current names
/// at once, then walk again.
pub fn changed(pid: i32) {
    with_cache(|c| c.invalidate(pid));
    trigger(pid);
}

/// Ask for a walk of `pid`'s window; repeated asks within DEBOUNCE merge.
pub fn trigger(pid: i32) {
    if pid <= 0 || pid == std::process::id() as i32 || !WANTED.load(Ordering::Relaxed) {
        return;
    }
    let tx = TRIGGERS.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<i32>();
        let _ = std::thread::Builder::new()
            .name("boost-list".into())
            .spawn(move || {
                while let Ok(pid) = rx.recv() {
                    match debounce(&rx, pid) {
                        Some(pid) => refresh(pid),
                        None => return,
                    }
                }
            });
        Mutex::new(tx)
    });
    let _ = tx.lock().unwrap_or_else(|p| p.into_inner()).send(pid);
}

/// Wait until triggers stop for DEBOUNCE; the newest pid wins. None when
/// the channel closed.
fn debounce(rx: &mpsc::Receiver<i32>, mut pid: i32) -> Option<i32> {
    loop {
        match rx.recv_timeout(DEBOUNCE) {
            Ok(next) => pid = next,
            Err(RecvTimeoutError::Timeout) => return Some(pid),
            Err(RecvTimeoutError::Disconnected) => return None,
        }
    }
}

#[cfg(target_os = "macos")]
fn refresh(pid: i32) {
    let started_gen = with_cache(|c| c.generation(pid));
    let Some(walked) = super::ax::walk(pid) else {
        return;
    };
    let texts: Vec<ScreenText> = walked
        .texts
        .iter()
        .map(|(text, distance)| ScreenText {
            text: text.clone(),
            distance: *distance,
        })
        .collect();
    let names = rank(&texts);
    debug!("Boost list: {} names cached for a window", names.len());
    match walked.reason {
        // A secure field is focused: nothing from this window may be used.
        "secure_field" => with_cache(|c| c.store_walk(pid, started_gen, walked.title, Vec::new())),
        "secure_input" | "not_trusted" | "no_window" | "worker_panic" => {}
        _ => with_cache(|c| c.store_walk(pid, started_gen, walked.title, names)),
    }
}

#[cfg(not(target_os = "macos"))]
fn refresh(_pid: i32) {}

fn frontmost_pid() -> Option<i32> {
    #[cfg(target_os = "macos")]
    {
        objc2_app_kit::NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Key-down: the cached names of the frontmost app's window, at once.
/// Also asks for a fresh walk for the next dictation.
pub fn cached_for_frontmost() -> Vec<Candidate> {
    let Some(pid) = frontmost_pid() else {
        return Vec::new();
    };
    trigger(pid);
    with_cache(|c| c.for_app(pid))
}

/// Watch app activation, and focus and title changes in the frontmost app,
/// to keep the cache fresh. Runs for the life of the app.
#[cfg(target_os = "macos")]
pub fn watch() {
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidActivateApplicationNotification};
    let (observe_tx, observe_rx) = mpsc::channel::<i32>();
    let _ = std::thread::Builder::new()
        .name("boost-ax-observer".into())
        .spawn(move || observer::run(observe_rx));
    if let Some(pid) = frontmost_pid() {
        trigger(pid);
        let _ = observe_tx.send(pid);
    }
    let block = block2::RcBlock::new(
        move |_note: std::ptr::NonNull<objc2_foundation::NSNotification>| {
            objc2::rc::autoreleasepool(|_| {
                if let Some(pid) = frontmost_pid() {
                    // The warm-up goes first on the walker's thread, so a
                    // Chromium or Electron tree is asked for before the walk.
                    if WANTED.load(Ordering::Relaxed) {
                        super::ax::warm(pid);
                    }
                    changed(pid);
                    let _ = observe_tx.send(pid);
                }
            })
        },
    );
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let token = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidActivateApplicationNotification),
            None,
            None,
            &block,
        )
    };
    std::mem::forget(token);
}

#[cfg(not(target_os = "macos"))]
pub fn watch() {}

#[cfg(target_os = "macos")]
mod observer {
    //! AX notifications for the frontmost app on a run-loop thread of its
    //! own; each one only triggers a debounced walk.
    use objc2_application_services::{AXError, AXObserver, AXUIElement};
    use objc2_core_foundation::{kCFRunLoopDefaultMode, CFRetained, CFRunLoop, CFString};
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::mpsc::Receiver;

    const NOTIFICATIONS: &[&str] = &[
        "AXFocusedUIElementChanged",
        "AXFocusedWindowChanged",
        "AXTitleChanged",
    ];

    unsafe extern "C-unwind" fn changed(
        _observer: NonNull<AXObserver>,
        _element: NonNull<AXUIElement>,
        _notification: NonNull<CFString>,
        refcon: *mut c_void,
    ) {
        super::changed(refcon as usize as i32);
    }

    struct Watched {
        observer: CFRetained<AXObserver>,
        app: CFRetained<AXUIElement>,
    }

    fn watch(pid: i32, run_loop: &CFRunLoop) -> Option<Watched> {
        let mut raw: *mut AXObserver = std::ptr::null_mut();
        let err = unsafe { AXObserver::create(pid, Some(changed), NonNull::from(&mut raw)) };
        if err != AXError::Success {
            return None;
        }
        let observer = unsafe { CFRetained::from_raw(NonNull::new(raw)?) };
        let app = unsafe { AXUIElement::new_application(pid) };
        for n in NOTIFICATIONS {
            let name = CFString::from_str(n);
            unsafe {
                let _ = observer.add_notification(&app, &name, pid as usize as *mut c_void);
            }
        }
        let source = unsafe { observer.run_loop_source() };
        run_loop.add_source(Some(&source), unsafe { kCFRunLoopDefaultMode });
        Some(Watched { observer, app })
    }

    fn unwatch(w: Watched, run_loop: &CFRunLoop) {
        for n in NOTIFICATIONS {
            let name = CFString::from_str(n);
            unsafe {
                let _ = w.observer.remove_notification(&w.app, &name);
            }
        }
        let source = unsafe { w.observer.run_loop_source() };
        run_loop.remove_source(Some(&source), unsafe { kCFRunLoopDefaultMode });
    }

    pub fn run(pids: Receiver<i32>) {
        let Some(run_loop) = CFRunLoop::current() else {
            return;
        };
        let mut current: Option<(i32, Watched)> = None;
        loop {
            objc2::rc::autoreleasepool(|_| {
                CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.25, false);
            });
            let mut newest = None;
            loop {
                match pids.try_recv() {
                    Ok(pid) => newest = Some(pid),
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => return,
                }
            }
            let Some(pid) = newest else { continue };
            if current.as_ref().is_some_and(|(p, _)| *p == pid) {
                continue;
            }
            if let Some((_, w)) = current.take() {
                unwatch(w, &run_loop);
            }
            if pid != std::process::id() as i32 {
                current = watch(pid, &run_loop).map(|w| (pid, w));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(terms: &[&str]) -> Vec<Candidate> {
        terms
            .iter()
            .map(|t| Candidate {
                term: t.to_string(),
                distance: 0,
                rarity: 2,
                count: 1,
            })
            .collect()
    }

    #[test]
    fn row14_key_down_uses_what_is_cached_and_never_waits() {
        let mut c = Cache::default();
        // Nothing walked yet: no screen names, custom words only.
        assert!(c.for_app(42).is_empty());
        c.store(42, "Inbox".into(), names(&["Zelberg"]));
        c.store(42, "Draft".into(), names(&["QuillPad"]));
        // The window walked last is the app's current one.
        assert_eq!(c.for_app(42)[0].term, "QuillPad");
        c.store(42, "Inbox".into(), names(&["Zelberg"]));
        assert_eq!(c.for_app(42)[0].term, "Zelberg");
    }

    #[test]
    fn row16_a_focus_change_hides_the_cached_names_until_the_next_walk() {
        // Focus may have moved to a secure field: until the walk reports
        // what is focused, key-down gets no screen names from this app.
        let mut c = Cache::default();
        c.store(7, "Login".into(), names(&["Zelberg"]));
        c.invalidate(7);
        assert!(c.for_app(7).is_empty());
        // The walk found a secure field focused: stored empty.
        c.store(7, "Login".into(), Vec::new());
        assert!(c.for_app(7).is_empty());
        // A walk that started before a focus change is not stored.
        let started = c.generation(7);
        c.invalidate(7);
        c.store_walk(7, started, "Login".into(), names(&["Zelberg"]));
        assert!(c.for_app(7).is_empty());
        c.store_walk(7, c.generation(7), "Login".into(), names(&["Zelberg"]));
        assert_eq!(c.for_app(7)[0].term, "Zelberg");
    }

    #[test]
    fn the_cache_forgets_the_oldest_windows() {
        let mut c = Cache::default();
        for i in 0..(CACHED_WINDOWS as i32 + 5) {
            c.store(i, "w".into(), names(&["X"]));
        }
        assert_eq!(c.windows.len(), CACHED_WINDOWS);
        assert!(!c.windows.contains_key(&(0, "w".into())));
    }

    #[test]
    fn row15_triggers_within_the_debounce_make_one_walk() {
        let (tx, rx) = mpsc::channel::<i32>();
        for pid in [6, 7] {
            tx.send(pid).unwrap();
        }
        let t = std::time::Instant::now();
        // Three triggers (5, 6, 7) in quick succession: one walk, of 7.
        assert_eq!(debounce(&rx, 5), Some(7));
        assert!(t.elapsed() >= DEBOUNCE);
        drop(tx);
        assert_eq!(debounce(&rx, 1), None);
    }
}
