//! Advisory call invitation. Only an explicit Start action can reach capture.
use super::detection::{CallApp, DetectionSnapshot};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const LABEL: &str = "call_invitation";
/// A single app must be seen this long before the prompt appears.
const SETTLE: Duration = Duration::from_secs(6);
/// A shown prompt survives this long without a fresh sighting of its app, so
/// a failed read, a slow browser scan or a dictation does not replace it
/// (replacing it gave it a new id and made a click on X fail).
const HOLD: Duration = Duration::from_secs(8);
/// A dismissed app stays quiet until it has been gone this long: the call ended.
const CALL_ENDED_AFTER: Duration = Duration::from_secs(60);
/// Offers remembered so X on a prompt that was already replaced still works.
const RECENT_OFFERS: usize = 8;

#[derive(Clone, Debug, PartialEq, serde::Serialize, specta::Type)]
pub struct Offer {
    pub id: u64,
    pub app: CallApp,
    pub fictional: bool,
}

#[derive(Clone, serde::Serialize, specta::Type)]
pub struct Destination {
    session_id: Option<String>,
    assistie_run: Option<String>,
}

#[derive(Default)]
struct State {
    offer: Option<Offer>,
    /// Last time the offered app was seen (or the read was inconclusive).
    offer_seen: Option<Instant>,
    candidate: Option<CallApp>,
    since: Option<Instant>,
    /// Dismissed apps with the last time each was seen in a call.
    snoozed: Vec<(CallApp, Instant)>,
    recent: Vec<Offer>,
    generation: u64,
    preview_until: Option<Instant>,
    pending: Option<Destination>,
    starting: bool,
}
impl State {
    /// `prompts`: the "Meeting prompts" setting. When off, bookkeeping (snoozes,
    /// preview expiry) still runs but no real prompt is shown.
    fn observe_with(
        &mut self,
        activity: DetectionSnapshot,
        recording: bool,
        prompts: bool,
        now: Instant,
    ) -> bool {
        let before = self.offer.clone();
        if self.preview_until.is_some_and(|end| end > now) && !recording {
            return false;
        }
        self.preview_until = None;
        if self.offer.as_ref().is_some_and(|o| o.fictional) {
            self.offer = None; // the preview window has passed
        }
        // A failed or stale read, or a dictation, says nothing about the call.
        let known = activity.available && !activity.dictating;
        for (app, seen) in &mut self.snoozed {
            if !known || activity.apps.contains(app) {
                *seen = now;
            }
        }
        self.snoozed
            .retain(|(_, seen)| now.saturating_duration_since(*seen) < CALL_ENDED_AFTER);

        if let Some(offer) = self.offer.clone().filter(|o| !o.fictional) {
            let other_app = known && activity.apps.iter().any(|a| *a != offer.app);
            if recording || other_app || self.is_snoozed(offer.app) {
                self.offer = None;
            } else if activity.dictating || (known && activity.apps.contains(&offer.app)) {
                // Seen, or the user is dictating (bounded): keep the same prompt.
                self.offer_seen = Some(now);
            } else if self
                .offer_seen
                .is_none_or(|seen| now.saturating_duration_since(seen) >= HOLD)
            {
                self.offer = None;
            }
        }

        let candidate = (known && !recording && activity.apps.len() == 1).then(|| activity.apps[0]);
        if candidate != self.candidate {
            self.candidate = candidate;
            self.since = Some(now);
        }
        if !prompts && self.offer.as_ref().is_some_and(|o| !o.fictional) {
            self.offer = None;
        }
        if let Some(app) = candidate.filter(|_| prompts) {
            if self.offer.is_none()
                && !self.starting
                && !self.is_snoozed(app)
                && self
                    .since
                    .is_some_and(|since| now.saturating_duration_since(since) >= SETTLE)
            {
                self.generation += 1;
                let offer = Offer {
                    id: self.generation,
                    app,
                    fictional: false,
                };
                self.recent.push(offer.clone());
                if self.recent.len() > RECENT_OFFERS {
                    self.recent.remove(0);
                }
                self.offer = Some(offer);
                self.offer_seen = Some(now);
            }
        }
        before != self.offer
    }
    #[cfg(test)]
    fn observe(&mut self, activity: DetectionSnapshot, recording: bool, now: Instant) -> bool {
        self.observe_with(activity, recording, true, now)
    }
    fn is_snoozed(&self, app: CallApp) -> bool {
        self.snoozed.iter().any(|(a, _)| *a == app)
    }
    fn claim(&mut self, id: u64, now: Instant) -> Result<Offer, String> {
        if self.starting {
            return Err("Invitation action already running".into());
        }
        let offer = self
            .offer
            .as_ref()
            .filter(|o| o.id == id)
            .cloned()
            .ok_or("This invitation has ended")?;
        if offer.fictional && self.preview_until.is_none_or(|end| end <= now) {
            return Err("Preview expired".into());
        }
        self.starting = true;
        Ok(offer)
    }
    /// After Start, Open or a dismissal: hide the prompt and keep its app
    /// quiet until that call ends.
    fn dismiss(&mut self, offer: &Offer, now: Instant) {
        if self
            .offer
            .as_ref()
            .is_some_and(|o| o.id == offer.id || o.app == offer.app)
        {
            self.offer = None;
        }
        if !offer.fictional && !self.is_snoozed(offer.app) {
            self.snoozed.push((offer.app, now));
        }
        self.preview_until = None;
        self.starting = false;
    }
    /// X or "Not now". Never fails: a prompt replaced since it was drawn is
    /// found among recent offers, so the click still silences its app.
    fn dismiss_id(&mut self, id: u64, now: Instant) {
        let offer = self
            .offer
            .clone()
            .filter(|o| o.id == id)
            .or_else(|| self.recent.iter().rev().find(|o| o.id == id).cloned())
            .or_else(|| self.offer.clone());
        match offer {
            Some(offer) => self.dismiss(&offer, now),
            None => {
                self.preview_until = None;
            }
        }
    }
}
#[derive(Default)]
pub struct Invitation(Mutex<State>);

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use tauri_nspanel::{
        tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask,
    };
    tauri_panel! { panel!(CallInvitationPanel { config: {
        can_become_key_window: true,
        can_become_main_window: false,
        becomes_key_only_if_needed: true,
        is_floating_panel: true
    } }) }
    pub fn layout(app: &AppHandle, height: f64) -> Result<(), String> {
        let monitor = app
            .primary_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("No display")?;
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let width = 440.0_f64.min(area.size.width as f64 / scale - 24.0);
        let x = area.position.x as f64 / scale + (area.size.width as f64 / scale - width) / 2.0;
        let y = (area.position.y + area.size.height as i32) as f64 / scale - height - 12.0;
        if let Some(window) = app.get_webview_window(LABEL) {
            window
                .set_size(tauri::LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            window
                .set_position(tauri::LogicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn create(app: &AppHandle) {
        let app = app.clone();
        let runner = app.clone();
        let _ = runner.run_on_main_thread(move || {
            let result = PanelBuilder::<_, CallInvitationPanel>::new(&app, LABEL)
                .url(tauri::WebviewUrl::App("src/invitation/index.html".into()))
                .title("Voce meeting invitation")
                .size(tauri::Size::Logical(tauri::LogicalSize::new(440.0, 76.0)))
                .level(PanelLevel::Floating)
                .has_shadow(false)
                .transparent(true)
                .no_activate(true)
                .hides_on_deactivate(false)
                .style_mask(StyleMask::empty().borderless().nonactivating_panel())
                .collection_behavior(
                    CollectionBehavior::new()
                        .can_join_all_spaces()
                        .full_screen_auxiliary(),
                )
                .with_window(|w| {
                    w.visible(false)
                        .decorations(false)
                        .transparent(true)
                        .resizable(false)
                        .skip_taskbar(true)
                        .focused(false)
                        .accept_first_mouse(true)
                })
                .build();
            match result {
                Ok(panel) => {
                    panel.as_panel().setExcludedFromWindowsMenu(false);
                    panel.hide();
                    let _ = layout(&app, 76.0);
                }
                Err(e) => log::warn!("Call invitation unavailable: {e}"),
            }
        });
    }
    pub fn publish(app: &AppHandle, offer: Option<Offer>) {
        let app = app.clone();
        let runner = app.clone();
        let _ = runner.run_on_main_thread(move || {
            // Read latest state on the main thread so an older show cannot undo dismissal.
            let current = app
                .state::<Invitation>()
                .0
                .lock()
                .ok()
                .and_then(|s| s.offer.clone());
            if current != offer {
                return;
            }
            if let Ok(panel) = app.get_webview_panel(LABEL) {
                if offer.is_some() {
                    let _ = layout(&app, 76.0);
                    panel.show();
                    if offer.as_ref().is_some_and(|o| o.fictional) {
                        // Preview is an explicit click in Handy, unlike automatic call detection.
                        panel.make_key_window();
                        if let Some(window) = app.get_webview_window(LABEL) {
                            let view: &tauri::Webview = window.as_ref();
                            let _ = view.set_focus();
                        }
                    }
                } else {
                    panel.hide();
                }
            }
            let _ = app.emit_to(LABEL, "call-invitation-changed", &offer);
        });
    }
}

pub fn create(app: &AppHandle) {
    if app.config().identifier != crate::APP_ID {
        return;
    }
    app.manage(Invitation::default());
    #[cfg(target_os = "macos")]
    native::create(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let calls = app.state::<super::CallNotesManager>();
            let activity = calls.detection_snapshot();
            let recording = calls.is_active();
            let enabled = crate::settings::get_settings(&app).call_invitations_enabled;
            let changed = app.state::<Invitation>().0.lock().ok().and_then(|mut s| {
                s.observe_with(activity, recording, enabled, Instant::now())
                    .then(|| s.offer.clone())
            });
            #[cfg(target_os = "macos")]
            if let Some(offer) = changed {
                native::publish(&app, offer);
            }
        }
    });
}

#[tauri::command]
#[specta::specta]
pub fn call_invitation_snapshot(app: AppHandle) -> Result<Option<Offer>, String> {
    Ok(app
        .try_state::<Invitation>()
        .ok_or("Invitations unavailable")?
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .offer
        .clone())
}

#[tauri::command]
#[specta::specta]
pub fn preview_call_invitation(app: AppHandle) -> Result<(), String> {
    if app.state::<super::CallNotesManager>().is_active() {
        return Err("Stop call notes before previewing".into());
    }
    let state = app
        .try_state::<Invitation>()
        .ok_or("Invitations unavailable")?;
    let mut state = state.0.lock().map_err(|e| e.to_string())?;
    if state.starting || state.offer.is_some() {
        return Err("An invitation is already open".into());
    }
    state.generation += 1;
    state.offer = Some(Offer {
        id: state.generation,
        app: CallApp::Discord,
        fictional: true,
    });
    state.preview_until = Some(Instant::now() + Duration::from_secs(300));
    let offer = state.offer.clone();
    drop(state);
    #[cfg(target_os = "macos")]
    native::publish(&app, offer);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn layout_call_invitation(app: AppHandle, height: u16) -> Result<(), String> {
    if ![76, 108, 200, 260].contains(&height) {
        return Err("Invalid invitation layout".into());
    }
    #[cfg(target_os = "macos")]
    {
        let runner = app.clone();
        runner
            .run_on_main_thread(move || {
                let _ = native::layout(&app, height as f64);
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Clone, Copy, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Choice {
    Start,
    Dismiss,
    Open,
}

#[tauri::command]
#[specta::specta]
pub async fn respond_call_invitation(
    app: AppHandle,
    id: u64,
    choice: Choice,
) -> Result<(), String> {
    if matches!(choice, Choice::Dismiss) {
        let state = app.state::<Invitation>();
        let mut state = state.0.lock().map_err(|e| e.to_string())?;
        state.dismiss_id(id, Instant::now());
        let current = state.offer.clone();
        drop(state);
        #[cfg(target_os = "macos")]
        native::publish(&app, current);
        return Ok(());
    }
    let offer = app
        .state::<Invitation>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .claim(id, Instant::now())?;
    let result = async {
        let mut destination = Destination {
            session_id: None,
            assistie_run: None,
        };
        if matches!(choice, Choice::Start) {
            if offer.fictional {
                // Preview Start can create only a text fixture, never an audio session, and only when Terra
                // (experimental) is on; otherwise the preview simply closes.
                if super::assistie::terra_enabled(&app) {
                    destination.assistie_run = Some(
                        super::assistie::create_assistie_fixture(app.clone())
                            .await?
                            .run_id
                            .clone(),
                    );
                }
            } else {
                let calls = app.state::<super::CallNotesManager>();
                let current = calls.detection_snapshot();
                if !current.available
                    || current.dictating
                    || current.apps.as_slice() != [offer.app]
                    || calls.is_active()
                {
                    return Err("Call activity changed. Open Voce to start notes manually.".into());
                }
                destination.session_id = super::start_call_notes(app.clone()).await?.map(|s| s.id);
                if destination.session_id.is_none() {
                    return Err("Call notes did not start".into());
                }
            }
        }
        if !matches!(choice, Choice::Dismiss) {
            app.state::<Invitation>()
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .pending = Some(destination);
            if let Some(main) = app.get_webview_window("main") {
                main.show().map_err(|e| e.to_string())?;
                main.set_focus().map_err(|e| e.to_string())?;
                let _ = main.emit("call-invitation-open", ());
            }
        }
        Ok(())
    }
    .await;
    let state = app.state::<Invitation>();
    let mut state = state.0.lock().map_err(|e| e.to_string())?;
    state.starting = false;
    if result.is_ok() {
        state.dismiss(&offer, Instant::now());
    }
    let current = state.offer.clone();
    drop(state);
    #[cfg(target_os = "macos")]
    if result.is_ok() {
        native::publish(&app, current);
    }
    result
}

#[tauri::command]
#[specta::specta]
pub fn take_call_invitation_destination(app: AppHandle) -> Result<Option<Destination>, String> {
    Ok(app
        .state::<Invitation>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .pending
        .take())
}

#[cfg(test)]
mod tests {
    //! One test per row of the prompt's event table
    //! (polish-audit-20261125/popup-bug.md).
    use super::*;
    fn signal(apps: Vec<CallApp>) -> DetectionSnapshot {
        DetectionSnapshot {
            available: true,
            apps,
            ..Default::default()
        }
    }
    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }
    /// A Discord prompt shown at t0 + SETTLE.
    fn shown() -> (State, Instant, u64) {
        let mut s = State::default();
        let t0 = Instant::now();
        assert!(!s.observe(signal(vec![CallApp::Discord]), false, t0));
        assert!(s.observe(signal(vec![CallApp::Discord]), false, t0 + SETTLE));
        let id = s.offer.as_ref().unwrap().id;
        (s, t0 + SETTLE, id)
    }

    #[test]
    fn row1_prompt_needs_one_app_seen_for_settle() {
        let mut s = State::default();
        let t0 = Instant::now();
        s.observe(signal(vec![CallApp::Zoom]), false, t0);
        s.observe(signal(vec![CallApp::Zoom]), false, t0 + secs(5));
        assert!(s.offer.is_none());
        s.observe(signal(vec![CallApp::Zoom]), false, t0 + SETTLE);
        assert_eq!(s.offer.as_ref().unwrap().app, CallApp::Zoom);
    }

    #[test]
    fn row2_failed_read_keeps_the_same_prompt_for_hold_then_clears() {
        let (mut s, t, id) = shown();
        s.observe(DetectionSnapshot::default(), false, t + secs(3));
        assert_eq!(
            s.offer.as_ref().map(|o| o.id),
            Some(id),
            "a blink must not replace it"
        );
        s.observe(signal(vec![CallApp::Discord]), false, t + secs(4));
        assert_eq!(s.offer.as_ref().map(|o| o.id), Some(id));
        s.observe(DetectionSnapshot::default(), false, t + secs(4) + HOLD);
        assert!(s.offer.is_none(), "unreadable for HOLD clears it");
    }

    #[test]
    fn row3_dictation_keeps_the_same_prompt() {
        let (mut s, t, id) = shown();
        let mut dictating = signal(vec![]);
        dictating.dictating = true;
        s.observe(dictating.clone(), false, t + secs(30));
        s.observe(dictating, false, t + secs(60));
        assert_eq!(s.offer.as_ref().map(|o| o.id), Some(id));
    }

    #[test]
    fn row4_a_second_app_clears_at_once_and_never_offers_capture() {
        let (mut s, t, id) = shown();
        assert!(s.observe(
            signal(vec![CallApp::Discord, CallApp::Zoom]),
            false,
            t + secs(1)
        ));
        assert!(s.offer.is_none());
        assert!(
            s.claim(id, t + secs(1)).is_err(),
            "Start on the old prompt stays refused"
        );
    }

    #[test]
    fn row5_recording_clears_at_once() {
        let (mut s, t, _) = shown();
        assert!(s.observe(signal(vec![CallApp::Discord]), true, t + secs(1)));
        assert!(s.offer.is_none());
    }

    #[test]
    fn row6_app_gone_clears_after_hold() {
        let (mut s, t, id) = shown();
        s.observe(signal(vec![]), false, t + secs(2));
        assert_eq!(s.offer.as_ref().map(|o| o.id), Some(id));
        s.observe(signal(vec![]), false, t + HOLD);
        assert!(s.offer.is_none());
    }

    #[test]
    fn row7_x_keeps_the_app_quiet_until_the_call_ends() {
        let (mut s, t, id) = shown();
        s.dismiss_id(id, t);
        assert!(s.offer.is_none());
        // Still in the call, with blinks and dictation, well past the old 30 minutes.
        for minute in 1..=45 {
            let at = t + secs(minute * 60);
            s.observe(signal(vec![CallApp::Discord]), false, at);
            s.observe(DetectionSnapshot::default(), false, at + secs(1));
            assert!(s.offer.is_none(), "came back at minute {minute}");
        }
        // Call ends: gone for CALL_ENDED_AFTER, then a new call offers again.
        let end = t + secs(45 * 60 + 2);
        s.observe(signal(vec![]), false, end);
        s.observe(signal(vec![]), false, end + CALL_ENDED_AFTER);
        let next = end + CALL_ENDED_AFTER + secs(1);
        s.observe(signal(vec![CallApp::Discord]), false, next);
        s.observe(signal(vec![CallApp::Discord]), false, next + SETTLE);
        assert!(s.offer.is_some());
    }

    #[test]
    fn row8_x_on_a_replaced_prompt_still_works() {
        let (mut s, t, old_id) = shown();
        // The prompt was replaced behind the user's back (read failed past HOLD).
        s.observe(DetectionSnapshot::default(), false, t + HOLD);
        s.observe(signal(vec![CallApp::Discord]), false, t + HOLD + secs(1));
        s.observe(
            signal(vec![CallApp::Discord]),
            false,
            t + HOLD + secs(1) + SETTLE,
        );
        let new_id = s.offer.as_ref().unwrap().id;
        assert_ne!(new_id, old_id);
        // The click on X still carries the old id.
        s.dismiss_id(old_id, t + HOLD + secs(8));
        assert!(s.offer.is_none());
        s.observe(signal(vec![CallApp::Discord]), false, t + HOLD + secs(30));
        assert!(s.offer.is_none());
    }

    #[test]
    fn row9_start_or_open_also_quiets_the_call() {
        let (mut s, t, id) = shown();
        let offer = s.claim(id, t).unwrap();
        s.dismiss(&offer, t);
        assert!(!s.starting);
        s.observe(signal(vec![CallApp::Discord]), false, t + secs(3600));
        assert!(s.offer.is_none());
    }

    #[test]
    fn row10_prompts_off_hides_real_prompts_but_keeps_bookkeeping() {
        let (mut s, t, id) = shown();
        assert!(s.observe_with(signal(vec![CallApp::Discord]), false, false, t + secs(1)));
        assert!(s.offer.is_none());
        // No new prompt while off.
        s.observe_with(signal(vec![CallApp::Discord]), false, false, t + secs(30));
        assert!(s.offer.is_none());
        // A snooze still ends while prompts are off, so re-enabling offers the next call.
        s.dismiss_id(id, t + secs(30));
        s.observe_with(signal(vec![]), false, false, t + secs(40));
        s.observe_with(
            signal(vec![]),
            false,
            false,
            t + secs(40) + CALL_ENDED_AFTER,
        );
        let back = t + secs(41) + CALL_ENDED_AFTER;
        s.observe_with(signal(vec![CallApp::Discord]), false, true, back);
        s.observe_with(signal(vec![CallApp::Discord]), false, true, back + SETTLE);
        assert!(s.offer.is_some());
        // A preview still expires while prompts are off.
        let mut p = State::default();
        p.offer = Some(Offer {
            id: 9,
            app: CallApp::Discord,
            fictional: true,
        });
        p.preview_until = Some(t);
        p.observe_with(signal(vec![]), false, false, t + secs(1));
        assert!(p.offer.is_none());
    }

    #[test]
    fn fictional_offers_expire_and_only_return_a_fictional_action() {
        let mut s = State::default();
        let now = Instant::now();
        s.offer = Some(Offer {
            id: 1,
            app: CallApp::Discord,
            fictional: true,
        });
        s.preview_until = Some(now + SETTLE);
        assert!(s.claim(1, now).unwrap().fictional);
        s.starting = false;
        assert!(s.claim(1, now + SETTLE).is_err());
        assert!(s.observe(signal(vec![]), false, now + SETTLE + HOLD));
        assert!(s.offer.is_none());
    }
}
