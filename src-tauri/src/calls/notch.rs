//! Opt-in, fictional meeting display. No recording, model or profile-account access.
use tauri::{AppHandle, Emitter, Manager};

const LABEL: &str = "assistie_notch";

#[derive(Clone, Copy, Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum NotchLayout {
    Compact,
    Peek,
    Expanded,
}

fn dimensions(layout: NotchLayout, camera_width: f64, header_height: f64) -> (f64, f64) {
    match layout {
        NotchLayout::Compact => (camera_width + 104.0, header_height + 4.0),
        NotchLayout::Peek => ((camera_width + 264.0).max(440.0), header_height + 42.0),
        // The chat needs a question, an answer with its source and two pointers in view.
        NotchLayout::Expanded => ((camera_width + 264.0).max(440.0), header_height + 382.0),
    }
}

/// Height a peek adds for each wrapped line past the first; the page clamps text to the same 16.
fn peek_extra_height(lines: u32) -> f64 {
    f64::from(lines.clamp(1, 16) - 1) * 18.0
}

fn hover_hit(point: [f64; 2], frame: [f64; 4], target: Option<[f64; 4]>) -> bool {
    let contains = |[x, y, width, height]: [f64; 4]| {
        point[0] >= x && point[0] <= x + width && point[1] >= y && point[1] <= y + height
    };
    contains(frame) || target.is_some_and(contains)
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use crate::calls::notch_motion::Spring;
    use objc2_app_kit::{NSApplication, NSColor, NSScreen, NSWorkspace};
    use std::{
        cell::RefCell,
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            mpsc,
        },
        time::{Duration, Instant},
    };
    use tauri_nspanel::{
        tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask,
    };

    static REFUSING_KEY: AtomicBool = AtomicBool::new(false);
    static MOTION_GENERATION: AtomicU64 = AtomicU64::new(0);
    static HOVER_GENERATION: AtomicU64 = AtomicU64::new(0);

    struct Motion {
        axes: [Spring; 2],
        target: [f64; 2],
        anchor: [f64; 2],
        frames: u32,
        response: f64,
        damping: f64,
        last: Instant,
        started: Instant,
    }

    tauri_panel! {
        panel!(AssistieNotchPanel {
            config: {
                can_become_key_window: !REFUSING_KEY.load(Ordering::Relaxed),
                can_become_main_window: false,
                becomes_key_only_if_needed: true,
                is_floating_panel: true
            }
        })
        panel!(AssistieFocusReleasePanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                becomes_key_only_if_needed: true
            }
        })
    }

    thread_local! {
        static FOCUS_HELPER: RefCell<Option<Retained<RawAssistieFocusReleasePanel>>> = const { RefCell::new(None) };
        static MOTION: RefCell<Option<Motion>> = const { RefCell::new(None) };
        static LAST_HOVER: RefCell<Option<bool>> = const { RefCell::new(None) };
        static LAST_LEVELS: RefCell<[f32; 2]> = const { RefCell::new([0.0; 2]) };
    }

    fn release_keyboard(panel: &objc2_app_kit::NSPanel) -> Result<(), String> {
        if !panel.isKeyWindow() {
            return Ok(());
        }
        let mtm = objc2::MainThreadMarker::new().ok_or("Focus release requires main thread")?;
        let foreground_before = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|a| a.processIdentifier());
        FOCUS_HELPER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let helper = slot.get_or_insert_with(|| {
                let allocated = RawAssistieFocusReleasePanel::alloc(mtm)
                    .set_ivars(AssistieFocusReleasePanelIvars);
                // SAFETY: initialize our main-thread NSPanel subclass using AppKit's designated initializer.
                let helper: Retained<RawAssistieFocusReleasePanel> = unsafe {
                    objc2::msg_send![super(allocated), initWithContentRect: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0)),
                        styleMask: objc2_app_kit::NSWindowStyleMask::NonactivatingPanel,
                        backing: objc2_app_kit::NSBackingStoreType::Buffered, defer: false]
                };
                helper.setOpaque(false);
                helper.setBackgroundColor(Some(&NSColor::clearColor()));
                helper.setHasShadow(false);
                helper.setIgnoresMouseEvents(true);
                helper.setHidesOnDeactivate(false);
                helper.setExcludedFromWindowsMenu(true);
                helper.setLevel(25);
                helper.setCollectionBehavior(objc2_app_kit::NSWindowCollectionBehavior::CanJoinAllSpaces
                    | objc2_app_kit::NSWindowCollectionBehavior::FullScreenAuxiliary);
                helper
            });
            let origin = panel.frame().origin;
            helper.setFrameOrigin(NSPoint::new(origin.x, origin.y - 1.0));
            // Prevent AppKit selecting the notch again while the clear helper yields the keyboard.
            REFUSING_KEY.store(true, Ordering::Relaxed);
            helper.makeKeyAndOrderFront(None);
            helper.orderOut(None);
            if panel.isKeyWindow() {
                panel.orderOut(None);
                panel.orderFrontRegardless();
            }
            REFUSING_KEY.store(false, Ordering::Relaxed);
        });
        let app = NSApplication::sharedApplication(mtm);
        let foreground_after = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|a| a.processIdentifier());
        log::info!(
            "Assistie focus helper: notch_key_after={}, app_active={}, foreground_unchanged={}",
            panel.isKeyWindow(),
            app.isActive(),
            foreground_before == foreground_after
        );
        if panel.isKeyWindow() {
            return Err("Notch keyboard release did not complete".into());
        }
        Ok(())
    }

    #[derive(Clone, serde::Serialize)]
    pub struct Geometry {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        camera_width: f64,
        header_height: f64,
    }

    fn geometry(app: &AppHandle, layout: NotchLayout) -> Result<Geometry, String> {
        let monitor = app
            .primary_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("No primary screen")?;
        let scale = monitor.scale_factor();
        let mtm = objc2::MainThreadMarker::new().ok_or("Screen query requires main thread")?;
        let (inset, camera_width) = NSScreen::screens(mtm)
            .firstObject()
            .map(|s| {
                let left = s.auxiliaryTopLeftArea();
                let right = s.auxiliaryTopRightArea();
                let gap = right.origin.x - (left.origin.x + left.size.width);
                (s.safeAreaInsets().top, gap)
            })
            .unwrap_or((0.0, 0.0));
        let camera_width = if inset > 0.0 {
            camera_width.max(0.0)
        } else {
            0.0
        };
        let header_height = inset.max(32.0);
        let (width, height) = dimensions(layout, camera_width, header_height);
        let screen_width = monitor.size().width as f64 / scale;
        let width = width.min((screen_width - 16.0).max(1.0));
        // Attach to the top edge; the webview reserves the camera gap inside its header.
        let y = monitor.position().y as f64 / scale;
        let x = monitor.position().x as f64 / scale + (screen_width - width) / 2.0;
        Ok(Geometry {
            x,
            y,
            width,
            height,
            camera_width,
            header_height,
        })
    }

    pub fn create(app: &AppHandle) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                let Geometry {
                    x,
                    y,
                    width,
                    height,
                    ..
                } = geometry(&handle, NotchLayout::Compact)?;
                let panel = PanelBuilder::<_, AssistieNotchPanel>::new(&handle, LABEL)
                    .url(tauri::WebviewUrl::App("src/notch/index.html".into()))
                    .title("Voce meeting preview")
                    .position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)))
                    .size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)))
                    .level(PanelLevel::Status)
                    .has_shadow(false)
                    .transparent(true)
                    .no_activate(true)
                    .hides_on_deactivate(false)
                    .style_mask(StyleMask::empty().borderless().nonactivating_panel())
                    .with_window(|w| {
                        w.visible(false)
                            .decorations(false)
                            .transparent(true)
                            .resizable(false)
                            .skip_taskbar(true)
                            .focused(false)
                            .accept_first_mouse(true)
                    })
                    .collection_behavior(
                        CollectionBehavior::new()
                            .can_join_all_spaces()
                            .full_screen_auxiliary(),
                    )
                    .build()
                    .map_err(|e| e.to_string())?;
                panel.hide();
                Ok(())
            })();
            if let Err(error) = result {
                log::error!("Assistie notch unavailable: {error}");
            }
        });
    }

    async fn on_main(
        app: AppHandle,
        action: impl FnOnce(AppHandle) -> Result<bool, String> + Send + 'static,
    ) -> Result<bool, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(action(handle));
        })
        .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(3))
                .map_err(|e| e.to_string())?
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn visible(app: AppHandle, show: bool) -> Result<bool, String> {
        MOTION_GENERATION.fetch_add(1, Ordering::Relaxed);
        let generation = HOVER_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        let handle = app.clone();
        let result = on_main(app, move |app| {
            MOTION.with(|motion| *motion.borrow_mut() = None);
            LAST_HOVER.with(|last| *last.borrow_mut() = None);
            LAST_LEVELS.with(|last| *last.borrow_mut() = [-1.0; 2]);
            let window = app.get_webview_window(LABEL).ok_or("Notch not ready")?;
            let panel = app
                .get_webview_panel(LABEL)
                .map_err(|_| "Notch panel missing")?;
            // Checked here, on the main thread where shows and hides run in order, so a show that was approved
            // before the Experimental switch went off cannot land after the switch-off hide.
            if show && !crate::calls::assistie::terra_enabled(&app) {
                return Err(crate::calls::assistie::TERRA_OFF.into());
            }
            if show {
                let geometry = geometry(&app, NotchLayout::Compact)?;
                window
                    .set_size(tauri::LogicalSize::new(geometry.width, geometry.height))
                    .map_err(|e| e.to_string())?;
                window
                    .set_position(tauri::LogicalPosition::new(geometry.x, geometry.y))
                    .map_err(|e| e.to_string())?;
                window
                    .emit("assistie-notch-geometry", geometry)
                    .map_err(|e| e.to_string())?;
                panel.show();
            } else {
                panel.hide();
            }
            app.emit("assistie-notch-visible", show)
                .map_err(|e| e.to_string())?;
            window.is_visible().map_err(|e| e.to_string())
        })
        .await;
        if show && matches!(result, Ok(true)) {
            track_hover(handle, generation);
        }
        result
    }

    fn track_hover(app: AppHandle, generation: u64) {
        tauri::async_runtime::spawn(async move {
            loop {
                let result = on_main(app.clone(), move |app| {
                    if HOVER_GENERATION.load(Ordering::Relaxed) != generation {
                        return Ok(false);
                    }
                    let panel = app
                        .get_webview_panel(LABEL)
                        .map_err(|_| "Notch panel missing")?;
                    if !panel.as_panel().isVisible() {
                        return Ok(false);
                    }
                    let frame = panel.as_panel().frame();
                    let point = objc2_app_kit::NSEvent::mouseLocation();
                    // Keep the destination inside the hover area while the panel animates.
                    let target = MOTION.with(|motion| {
                        motion.borrow().as_ref().map(|m| {
                            [
                                m.anchor[0] - m.target[0] / 2.0,
                                m.anchor[1] - m.target[1],
                                m.target[0],
                                m.target[1],
                            ]
                        })
                    });
                    let inside = hover_hit(
                        [point.x, point.y],
                        [
                            frame.origin.x,
                            frame.origin.y,
                            frame.size.width,
                            frame.size.height,
                        ],
                        target,
                    );
                    LAST_HOVER.with(|last| -> Result<(), String> {
                        let mut last = last.borrow_mut();
                        if *last != Some(inside) {
                            app.get_webview_window(LABEL)
                                .ok_or("Notch not ready")?
                                .emit("assistie-notch-hover", inside)
                                .map_err(|e| e.to_string())?;
                            *last = Some(inside);
                            log::debug!("Assistie notch hover: inside={inside}");
                        }
                        Ok(())
                    })?;
                    // The level bars: call loudness (mic, call audio).
                    let levels = crate::calls::capture::live_levels();
                    LAST_LEVELS.with(|last| -> Result<(), String> {
                        let mut last = last.borrow_mut();
                        // Every tick while there is sound (a re-mounted wave needs it); repeated silence once.
                        if *last != levels || levels != [0.0; 2] {
                            app.get_webview_window(LABEL)
                                .ok_or("Notch not ready")?
                                .emit("assistie-notch-levels", levels)
                                .map_err(|e| e.to_string())?;
                            *last = levels;
                        }
                        Ok(())
                    })?;
                    Ok(true)
                })
                .await;
                match result {
                    Ok(true) => tokio::time::sleep(Duration::from_millis(75)).await,
                    Ok(false) => break,
                    Err(error) => {
                        log::error!("Assistie notch hover: {error}");
                        break;
                    }
                }
            }
        });
    }

    pub async fn layout(
        app: AppHandle,
        mode: NotchLayout,
        lines: u32,
        reduced: bool,
    ) -> Result<bool, String> {
        let generation = MOTION_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        let handle = app.clone();
        let showing = on_main(app, move |app| {
            if MOTION_GENERATION.load(Ordering::Relaxed) != generation {
                return Ok(false);
            }
            let window = app.get_webview_window(LABEL).ok_or("Notch not ready")?;
            let panel = app
                .get_webview_panel(LABEL)
                .map_err(|_| "Notch panel missing")?;
            if !panel.as_panel().isVisible() {
                return Ok(false);
            }
            let mut geometry = geometry(&app, mode)?;
            if matches!(mode, NotchLayout::Peek) {
                geometry.height += super::peek_extra_height(lines);
            }
            let frame = panel.as_panel().frame();
            MOTION.with(|slot| {
                let mut slot = slot.borrow_mut();
                let mut axes = slot.as_ref().map(|m| m.axes).unwrap_or([
                    Spring::new(frame.size.width),
                    Spring::new(frame.size.height),
                ]);
                axes[0].value = frame.size.width;
                axes[1].value = frame.size.height;
                let (response, damping) = match mode {
                    NotchLayout::Compact => (0.45, 1.0),
                    NotchLayout::Peek => (0.42, 0.82),
                    NotchLayout::Expanded => (0.20, 0.90),
                };
                *slot = Some(Motion {
                    axes,
                    target: [geometry.width, geometry.height],
                    anchor: [
                        frame.origin.x + frame.size.width / 2.0,
                        frame.origin.y + frame.size.height,
                    ],
                    frames: 0,
                    response,
                    damping,
                    last: Instant::now(),
                    started: Instant::now(),
                });
            });
            if reduced {
                panel.as_panel().setFrame_display(
                    NSRect::new(
                        NSPoint::new(
                            frame.origin.x + (frame.size.width - geometry.width) / 2.0,
                            frame.origin.y + frame.size.height - geometry.height,
                        ),
                        NSSize::new(geometry.width, geometry.height),
                    ),
                    true,
                );
                MOTION.with(|slot| *slot.borrow_mut() = None);
            }
            window
                .emit("assistie-notch-geometry", geometry)
                .map_err(|e| e.to_string())?;
            log::info!("Assistie notch motion {generation}: {mode:?}, reduced={reduced}");
            window.is_visible().map_err(|e| e.to_string())
        })
        .await?;
        if showing && !reduced {
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(16)).await;
                    let result = on_main(handle.clone(), move |app| {
                        if MOTION_GENERATION.load(Ordering::Relaxed) != generation {
                            return Ok(false);
                        }
                        let panel = app
                            .get_webview_panel(LABEL)
                            .map_err(|_| "Notch panel missing")?;
                        if !panel.as_panel().isVisible() {
                            return Ok(false);
                        }
                        MOTION.with(|slot| {
                            let mut slot = slot.borrow_mut();
                            let Some(motion) = slot.as_mut() else {
                                return Ok(false);
                            };
                            let now = Instant::now();
                            let elapsed = now.duration_since(motion.last).as_secs_f64();
                            motion.last = now;
                            motion.frames += 1;
                            for (axis, target) in motion.axes.iter_mut().zip(motion.target) {
                                axis.advance(target, elapsed, motion.response, motion.damping);
                            }
                            let done = motion
                                .axes
                                .iter()
                                .zip(motion.target)
                                .all(|(a, t)| a.settled(t))
                                || now.duration_since(motion.started) > Duration::from_secs(1);
                            let [width, height] = if done {
                                motion.target
                            } else {
                                [motion.axes[0].value.max(1.0), motion.axes[1].value.max(1.0)]
                            };
                            panel.as_panel().setFrame_display(
                                NSRect::new(
                                    NSPoint::new(
                                        motion.anchor[0] - width / 2.0,
                                        motion.anchor[1] - height,
                                    ),
                                    NSSize::new(width, height),
                                ),
                                true,
                            );
                            if done {
                                log::info!("Assistie notch motion {generation}: settled {} frames {}ms {}x{}", motion.frames, now.duration_since(motion.started).as_millis(), width, height);
                                *slot = None;
                            }
                            Ok(!done)
                        })
                    })
                    .await;
                    match result {
                        Ok(true) => (),
                        Ok(false) => break,
                        Err(error) => {
                            log::error!("Assistie notch motion: {error}");
                            break;
                        }
                    }
                }
            });
        }
        Ok(showing)
    }

    pub async fn editing(app: AppHandle, editing: bool) -> Result<bool, String> {
        on_main(app, move |app| {
            let window = app.get_webview_window(LABEL).ok_or("Notch not ready")?;
            let panel = app
                .get_webview_panel(LABEL)
                .map_err(|_| "Notch panel missing")?;
            if editing && window.is_visible().map_err(|e| e.to_string())? {
                panel.make_key_window();
            } else {
                let mtm =
                    objc2::MainThreadMarker::new().ok_or("Focus release requires main thread")?;
                if panel.as_panel().isKeyWindow() {
                    if let Some(main) = NSApplication::sharedApplication(mtm)
                        .mainWindow()
                        .filter(|main| main.isVisible() && !main.isMiniaturized())
                    {
                        // The Tauri main webview needs its tested same-app key handoff.
                        main.makeKeyWindow();
                        log::info!("Assistie focus release: visible main window restored");
                    } else {
                        release_keyboard(panel.as_panel())?;
                    }
                }
            }
            window.is_focused().map_err(|e| e.to_string())
        })
        .await
    }
}

pub fn create(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    native::create(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
#[specta::specta]
pub async fn set_assistie_notch_visible(app: AppHandle, visible: bool) -> Result<bool, String> {
    if visible && !super::assistie::notch_allowed(&app).await? {
        return Err("Enable meeting sharing before showing Assistie".into());
    }
    #[cfg(target_os = "macos")]
    return native::visible(app, visible).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
        Err("The dev notch is currently macOS only".into())
    }
}

/// Shows the notch for a share the caller already allowed and holds the bridge lock for.
pub(super) async fn show_for_share(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return native::visible(app, true).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("The dev notch is currently macOS only".into())
    }
}

#[tauri::command]
#[specta::specta]
pub fn assistie_notch_visible(app: AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

#[tauri::command]
#[specta::specta]
pub async fn layout_assistie_notch(
    app: AppHandle,
    mode: NotchLayout,
    lines: Option<u32>,
    reduce_motion: Option<bool>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return native::layout(
        app,
        mode,
        lines.unwrap_or(1),
        reduce_motion.unwrap_or(false),
    )
    .await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, mode, lines, reduce_motion);
        Err("The dev notch is currently macOS only".into())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn edit_assistie_notch(app: AppHandle, editing: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return native::editing(app, editing).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, editing);
        Err("The dev notch is currently macOS only".into())
    }
}

/// How long the ended notch shows "Saved" before it hides. Kept in step with PACING.savedMs in feed.ts.
const SAVED_HIDE_MS: u64 = 4000;

/// One "Saved" countdown at a time, cancelled by any live run seen since it began.
mod saved {
    use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
    static LIVE: AtomicU64 = AtomicU64::new(0);
    const NONE: u64 = u64::MAX;
    static PENDING: AtomicU64 = AtomicU64::new(NONE);
    static LAST_RUN: AtomicU64 = AtomicU64::new(0);

    /// A run that allows the notch was seen (sharing resumed, or a new call started).
    pub fn live() {
        LIVE.fetch_add(1, SeqCst);
    }
    /// Starts a countdown for this ended stretch, or None when one is already running for it.
    /// A different run counts as having gone live, even if no poll saw it live.
    pub fn begin(run_id: &str) -> Option<u64> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        run_id.hash(&mut hasher);
        let run = hasher.finish();
        if LAST_RUN.swap(run, SeqCst) != run {
            live();
        }
        let generation = LIVE.load(SeqCst);
        (PENDING.swap(generation, SeqCst) != generation).then_some(generation)
    }
    /// Ends a countdown; true when nothing went live while it ran.
    pub fn finish(generation: u64) -> bool {
        let _ = PENDING.compare_exchange(generation, NONE, SeqCst, SeqCst);
        LIVE.load(SeqCst) == generation
    }
}
pub(super) use saved::live as notch_run_live;

/// The run ended or sharing stopped: leave the notch up long enough to say "Saved", then hide it,
/// unless by then a run allows the notch again (a new call started, or sharing resumed).
pub(super) fn hide_after_saved(app: AppHandle, run_id: &str) {
    // The snapshot poll sees the ended run every second; one countdown per ended stretch.
    let Some(generation) = saved::begin(run_id) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(SAVED_HIDE_MS)).await;
        // A failed check leaves the notch up: the next poll that sees the ended run tries again.
        if saved::finish(generation)
            && matches!(super::assistie::notch_allowed(&app).await, Ok(false))
        {
            let _ = set_assistie_notch_visible(app, false).await;
        }
    });
}

/// What the notch showed and what the user saw, one line per event, never any reply text.
mod seen_log {
    use serde::{Deserialize, Serialize};
    use std::io::Write;
    use std::path::{Path, PathBuf};

    pub const ACTIONS: [&str; 4] = ["shown", "seen", "dismissed", "skipped"];
    const READ_LIMIT: u64 = 4 << 20;

    #[derive(Serialize, Deserialize, specta::Type)]
    pub struct NotchEvent {
        pub n: u32,
        pub action: String,
    }

    pub fn path(root: &Path, run_id: &str) -> Result<PathBuf, String> {
        let valid = (1..=64).contains(&run_id.len())
            && run_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !valid {
            return Err("Invalid meeting run".into());
        }
        Ok(root.join("assistie-notch").join(format!("{run_id}.jsonl")))
    }

    pub fn append(path: &Path, events: &[NotchEvent], at_ms: i64) -> Result<(), String> {
        if events.is_empty() || events.len() > 64 {
            return Err("Use 1 to 64 notch events".into());
        }
        if let Some(bad) = events
            .iter()
            .find(|e| !ACTIONS.contains(&e.action.as_str()))
        {
            return Err(format!("Unknown notch action {}", bad.action));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // One write per batch, so a crash leaves at most one torn last line, which reads skip.
        let mut lines = String::new();
        for e in events {
            lines += &serde_json::json!({"n": e.n, "at_ms": at_ms, "action": e.action}).to_string();
            lines.push('\n');
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| file.write_all(lines.as_bytes()))
            .map_err(|e| e.to_string())
    }

    pub fn seen(path: &Path) -> Result<Vec<u32>, String> {
        use std::io::Read;
        let mut text = String::new();
        match std::fs::File::open(path) {
            Ok(file) => file
                .take(READ_LIMIT)
                .read_to_string(&mut text)
                .map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.to_string()),
        };
        let mut seen: Vec<u32> = text
            .lines()
            .filter_map(|line| serde_json::from_str::<NotchEvent>(line).ok())
            .filter(|e| e.action == "seen" || e.action == "dismissed")
            .map(|e| e.n)
            .collect();
        seen.sort_unstable();
        seen.dedup();
        Ok(seen)
    }
}
pub use seen_log::NotchEvent;

fn log_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn record_notch_events(
    app: AppHandle,
    run_id: String,
    events: Vec<NotchEvent>,
) -> Result<(), String> {
    let at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    seen_log::append(&seen_log::path(&log_root(&app)?, &run_id)?, &events, at_ms)
}

/// Reply numbers the user has seen (or dismissed on purpose) in this run, so a reload keeps the unseen count.
#[tauri::command]
#[specta::specta]
pub fn notch_seen_replies(app: AppHandle, run_id: String) -> Result<Vec<u32>, String> {
    seen_log::seen(&seen_log::path(&log_root(&app)?, &run_id)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notch_log_rebuilds_the_seen_set_and_skips_a_torn_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = seen_log::path(dir.path(), "meeting-abc").unwrap();
        let event = |n, action: &str| NotchEvent {
            n,
            action: action.into(),
        };
        seen_log::append(
            &path,
            &[event(1, "shown"), event(1, "seen"), event(3, "dismissed")],
            5,
        )
        .unwrap();
        seen_log::append(&path, &[event(2, "skipped"), event(1, "seen")], 6).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, b"{\"n\":4,\"act"))
            .unwrap();
        assert_eq!(seen_log::seen(&path).unwrap(), vec![1, 3]);
        assert_eq!(
            seen_log::seen(&dir.path().join("missing.jsonl")).unwrap(),
            Vec::<u32>::new()
        );
        assert!(seen_log::append(&path, &[event(1, "read")], 7).is_err());
        assert!(seen_log::append(&path, &[], 7).is_err());
        assert!(seen_log::path(dir.path(), "../x").is_err());
        assert!(!std::fs::read_to_string(&path).unwrap().contains("text"));
    }

    #[test]
    fn saved_countdown_is_single_and_cancelled_by_a_live_run() {
        let first = saved::begin("run-a").expect("an ended run starts a countdown");
        assert_eq!(
            saved::begin("run-a"),
            None,
            "the poll repeating the end does not restart it"
        );
        saved::live(); // Sharing resumed before the countdown ran out.
        let second = saved::begin("run-a").expect("the next end starts its own countdown");
        assert!(
            !saved::finish(first),
            "the old countdown must not hide the resumed run"
        );
        let third = saved::begin("run-b").expect("another run's end never joins this countdown");
        assert!(!saved::finish(second));
        assert!(saved::finish(third));
        assert!(
            saved::begin("run-b").is_some(),
            "a finished countdown can be restarted by the poll"
        );
    }

    #[test]
    fn chat_panel_is_taller_than_the_old_card() {
        assert_eq!(
            dimensions(NotchLayout::Expanded, 184.0, 38.0),
            (448.0, 420.0)
        );
    }

    #[test]
    fn pointer_tucks_to_small_hit_area_and_expansion_is_bounded() {
        assert_eq!(dimensions(NotchLayout::Compact, 184.0, 38.0), (288.0, 42.0));
        assert_eq!(dimensions(NotchLayout::Compact, 0.0, 32.0), (104.0, 36.0));
        assert!(
            dimensions(NotchLayout::Peek, 184.0, 38.0).1
                < dimensions(NotchLayout::Expanded, 184.0, 38.0).1
        );
    }

    #[test]
    fn a_peek_grows_a_line_at_a_time_up_to_sixteen() {
        assert_eq!(peek_extra_height(0), 0.0);
        assert_eq!(peek_extra_height(1), 0.0);
        assert_eq!(peek_extra_height(3), 36.0);
        assert_eq!(peek_extra_height(40), 270.0);
    }

    #[test]
    fn hover_covers_camera_wings_and_animation_destination() {
        let compact = [600.0, 958.0, 288.0, 42.0];
        let expanded = [520.0, 580.0, 448.0, 420.0];
        assert!(hover_hit([744.0, 985.0], compact, None)); // Camera gap.
        assert!(hover_hit([620.0, 985.0], compact, None)); // Avatar wing.
        assert!(hover_hit([870.0, 985.0], compact, None)); // Status wing.
        assert!(!hover_hit([744.0, 900.0], compact, None));
        assert!(hover_hit([744.0, 900.0], compact, Some(expanded)));
        assert!(hover_hit([744.0, 900.0], expanded, Some(compact)));
        assert!(!hover_hit([500.0, 900.0], compact, Some(expanded)));
    }
}
