//! First-run onboarding state (docs/onboarding-lifecycle.md): the step to
//! resume at, the speech model being downloaded, the Try it step's
//! shortcuts, and the Names switch. The cleanup step lives in
//! `cleanup_setup`, the storage page in `storage`.

use crate::settings::{get_settings, write_settings, AppSettings, OnboardingStep};
use serde::Serialize;
use specta::Type;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

/// Try it is open: dictations started now go to the practice box.
static PRACTICE: AtomicBool = AtomicBool::new(false);

pub fn practice() -> bool {
    PRACTICE.load(Ordering::Acquire)
}

fn set_practice(on: bool) {
    PRACTICE.store(on, Ordering::Release);
}

/// Practice mode on while `init` runs, and off again if it fails, so a Try
/// it that could not start never keeps capturing dictations.
fn with_practice<T>(init: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    set_practice(true);
    let result = init();
    if result.is_err() {
        set_practice(false);
    }
    result
}

/// End practice mode; true when it was on.
fn end_practice() -> bool {
    PRACTICE.swap(false, Ordering::AcqRel)
}

/// The main window closed (it only hides): Try it is gone from view, so
/// practice ends and a dictation it captured is cancelled. Switching to
/// another app does not end it (row 23). The frontend calls
/// `begin_onboarding_try` again when Try it is shown again.
pub fn main_window_closed(app: &AppHandle) {
    if end_practice() {
        crate::utils::cancel_current_operation(app);
    }
}

/// The event a Try it dictation sends instead of pasting.
pub const PRACTICE_EVENT: &str = "onboarding-practice-text";

#[derive(Debug, Clone, Serialize, Type)]
pub struct PracticeText {
    /// What Voce would have pasted.
    pub text: String,
    /// Cleanup ran on it.
    pub cleaned: bool,
}

pub fn emit_practice_text(app: &AppHandle, text: String, cleaned: bool) {
    let _ = app.emit(PRACTICE_EVENT, PracticeText { text, cleaned });
}

impl OnboardingStep {
    fn next(self) -> Self {
        use OnboardingStep::*;
        match self {
            Welcome => Permissions,
            Permissions => Speech,
            Speech => Cleanup,
            Cleanup => Try,
            Try => Names,
            Names => Storage,
            Storage | Done => Done,
        }
    }
}

/// `completed` is done: store the step after it. Never moves back, so going
/// back and finishing an earlier step again, or the permission screen a
/// returning user sees, keeps the step already reached (rows 4 and 4b).
pub(crate) fn complete(settings: &mut AppSettings, completed: OnboardingStep) -> OnboardingStep {
    let next = settings.onboarding_step.max(completed.next());
    settings.onboarding_step = next;
    if next == OnboardingStep::Done {
        settings.onboarding_completed = true;
        settings.onboarding_pending_model = None;
    }
    next
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct OnboardingState {
    pub step: OnboardingStep,
    /// The speech model the Speech step started downloading, if any.
    pub pending_model: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn get_onboarding_state(app: AppHandle) -> OnboardingState {
    let settings = get_settings(&app);
    OnboardingState {
        step: settings.onboarding_step,
        pending_model: settings.onboarding_pending_model,
    }
}

/// Mark `step` complete; returns the step to show next.
#[tauri::command]
#[specta::specta]
pub fn complete_onboarding_step(app: AppHandle, step: OnboardingStep) -> OnboardingStep {
    let mut settings = get_settings(&app);
    let next = complete(&mut settings, step);
    write_settings(&app, settings);
    next
}

#[tauri::command]
#[specta::specta]
pub fn set_onboarding_pending_model(app: AppHandle, model_id: Option<String>) {
    let mut settings = get_settings(&app);
    settings.onboarding_pending_model = model_id;
    write_settings(&app, settings);
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct TryStart {
    /// Shortcuts that could not be registered (row 21), e.g. taken by
    /// another dictation app. Empty when all work.
    pub failed_shortcuts: Vec<crate::shortcut::ShortcutFailure>,
}

/// Try it (rows 20, 21, 23): the dictation shortcuts and the paste keyboard,
/// which the main window otherwise sets up only once onboarding is done
/// (both idempotent), and practice mode: until `end_onboarding_try`, a
/// dictation's text arrives as `onboarding-practice-text` and nothing is
/// pasted into any app.
#[tauri::command]
#[specta::specta]
pub fn begin_onboarding_try(app: AppHandle) -> Result<TryStart, String> {
    with_practice(|| {
        crate::commands::initialize_enigo(app.clone())?;
        crate::commands::initialize_shortcuts(app)?;
        Ok(TryStart {
            failed_shortcuts: crate::shortcut::init_failures(),
        })
    })
}

/// Leaving or cancelling Try it (row 20b): practice mode ends and any
/// recording stops; a dictation already transcribing or cleaning sees the
/// cancellation and delivers nothing.
#[tauri::command]
#[specta::specta]
pub fn end_onboarding_try(app: AppHandle) {
    end_practice();
    crate::utils::cancel_current_operation(&app);
}

/// Names (row 24): off stops window reads for names and drops the cache.
#[tauri::command]
#[specta::specta]
pub fn change_screen_names_setting(app: AppHandle, enabled: bool) {
    let mut settings = get_settings(&app);
    settings.screen_names = enabled;
    write_settings(&app, settings);
    crate::boost::screen::set_enabled(enabled);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;
    use OnboardingStep::*;

    const ORDER: [OnboardingStep; 8] = [
        Welcome,
        Permissions,
        Speech,
        Cleanup,
        Try,
        Names,
        Storage,
        Done,
    ];

    #[test]
    fn row1_a_fresh_install_starts_at_welcome() {
        let settings = get_default_settings();
        assert_eq!(settings.onboarding_step, Welcome);
        assert!(!settings.onboarding_completed);
    }

    #[test]
    fn row2b_each_completed_step_resumes_at_the_next_one() {
        // Quitting right after a step completes leaves its successor stored:
        // nothing repeats and nothing is skipped, Welcome and Permissions included.
        let mut settings = get_default_settings();
        for pair in ORDER.windows(2) {
            assert_eq!(settings.onboarding_step, pair[0]);
            assert_eq!(complete(&mut settings, pair[0]), pair[1]);
            let stored: AppSettings =
                serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
            assert_eq!(stored.onboarding_step, pair[1]);
        }
        assert!(settings.onboarding_completed);
    }

    #[test]
    fn row3_relaunch_at_a_later_step_keeps_earlier_choices() {
        let mut settings = get_default_settings();
        for step in [Welcome, Permissions, Speech] {
            complete(&mut settings, step);
        }
        settings.selected_model = "parakeet".into();
        settings.post_process_enabled = true;
        for step in [Cleanup, Try, Names] {
            complete(&mut settings, step);
            let stored: AppSettings =
                serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
            assert_eq!(stored.selected_model, "parakeet");
            assert!(stored.post_process_enabled);
            assert!(!stored.onboarding_completed);
        }
    }

    #[test]
    fn row4_a_done_user_granting_permissions_goes_back_to_main() {
        let mut settings = get_default_settings();
        settings.onboarding_step = Done;
        settings.onboarding_completed = true;
        assert_eq!(complete(&mut settings, Permissions), Done);
    }

    #[test]
    fn row4b_permissions_regranted_mid_onboarding_return_to_the_saved_step() {
        for saved in [Cleanup, Try, Names, Storage] {
            let mut settings = get_default_settings();
            settings.onboarding_step = saved;
            assert_eq!(complete(&mut settings, Permissions), saved);
            assert!(!settings.onboarding_completed);
        }
    }

    #[test]
    fn row6_a_relaunch_after_granting_resumes_at_permissions() {
        let mut settings = get_default_settings();
        complete(&mut settings, Welcome);
        assert_eq!(settings.onboarding_step, Permissions);
    }

    #[test]
    fn row9_the_pending_speech_model_survives_a_relaunch_until_done() {
        let mut settings = get_default_settings();
        complete(&mut settings, Welcome);
        complete(&mut settings, Permissions);
        settings.onboarding_pending_model = Some("parakeet".into());
        complete(&mut settings, Speech);
        let stored: AppSettings =
            serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert_eq!(stored.onboarding_pending_model.as_deref(), Some("parakeet"));
        for step in [Cleanup, Try, Names, Storage] {
            complete(&mut settings, step);
        }
        assert_eq!(settings.onboarding_pending_model, None);
    }

    /// Practice mode is process-wide.
    static PRACTICE_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn review2_n3_a_failed_start_or_a_closed_window_ends_practice() {
        let _serial = PRACTICE_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let failed: Result<(), String> = with_practice(|| {
            assert!(practice(), "on while starting");
            Err("no accessibility".into())
        });
        assert!(failed.is_err());
        assert!(!practice(), "rolled back");
        assert!(with_practice(|| Ok(())).is_ok());
        assert!(practice(), "on after a good start, through app switches");
        assert!(end_practice(), "closing the window ends it");
        assert!(!practice());
        assert!(!end_practice(), "nothing to cancel the second time");
    }

    #[test]
    fn row23_try_it_dictations_go_to_the_practice_box_until_it_ends() {
        let _serial = PRACTICE_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        assert!(!practice(), "normal dictation pastes");
        set_practice(true);
        assert!(practice(), "a dictation started now is a practice one");
        let payload = serde_json::to_value(PracticeText {
            text: "Hello.".into(),
            cleaned: true,
        })
        .unwrap();
        assert_eq!(
            payload,
            serde_json::json!({"text": "Hello.", "cleaned": true})
        );
        set_practice(false);
        assert!(!practice());
    }

    #[test]
    fn row27_finish_marks_onboarding_done() {
        let mut settings = get_default_settings();
        settings.onboarding_step = Storage;
        assert_eq!(complete(&mut settings, Storage), Done);
        assert!(settings.onboarding_completed);
    }
}
