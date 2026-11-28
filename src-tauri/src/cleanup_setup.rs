//! Onboarding's cleanup step (table rows 11 to 18): find LM Studio and
//! Ollama, test a choice on one messy sentence, and save it only after its
//! own test passed.
//!
//! A test runs through the same request code as dictation (`run_cleanup`),
//! but strictly: no reply, unparsed output, an answer instead of a cleanup,
//! or the raw sentence passed back are all failures, never a pass.

use crate::actions::{run_cleanup, CleanupFailure, PostProcessTarget};
use crate::settings::{
    default_post_process_prompts, get_settings, write_settings, AppSettings, LLMPrompt,
    APPLE_INTELLIGENCE_PROVIDER_ID, DEFAULT_PROMPT_ID, VOCE_LOCAL_MODEL, VOCE_LOCAL_PROVIDER_ID,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// The sentence every test cleans (the mockup's "You say").
pub const SAMPLE: &str =
    "um so I think we should uh move the the standup to thursday, like, at ten";
/// A test that has not answered by now fails as `timeout` (row 14).
const TEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Detection never holds the screen up (row 13).
const DETECT_TIMEOUT: Duration = Duration::from_secs(1);
/// A model list that has not arrived by now fails as `timeout`.
const LIST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CleanupChoice {
    /// s1-mini on Voce's own runtime.
    VoceLocal,
    /// LM Studio, Ollama or another OpenAI-compatible server on this Mac.
    LocalServer {
        base_url: String,
        model: String,
    },
    /// A cloud provider from the provider list, with the user's key.
    Cloud {
        provider_id: String,
        api_key: String,
        model: String,
    },
    AppleIntelligence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TestOutcome {
    Passed,
    DownloadNeeded,
    StartFailed,
    Unreachable,
    Timeout,
    Empty,
    Malformed,
    Hijacked,
    KeyRejected,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct CleanupTestResult {
    /// The id the frontend sent; it ignores results for older ids (row 16b).
    pub request_id: u32,
    pub outcome: TestOutcome,
    /// What Voce would paste (passed tests only).
    pub output: Option<String>,
    /// The cleanup request alone: what each dictation waits for.
    pub ms: u32,
    /// Starting Voce cleanup's server first, when it was not running
    /// (0 otherwise). The first start on a Mac can take many seconds.
    pub start_ms: u32,
}

fn toks(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '\''))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// The cleanup eval's `hijacked` check: the output stopped being the
/// speaker's text (it answered, obeyed or wandered off): mostly words the
/// speaker never said, or far longer than what was said.
pub fn hijacked(input: &str, output: &str) -> bool {
    let (i, o) = (toks(input), toks(output));
    if o.is_empty() {
        return false;
    }
    let novel = o.iter().filter(|w| !i.contains(w)).count() as f64 / o.len() as f64;
    novel > 0.35 || o.len() as f64 > 1.6 * i.len().max(5) as f64
}

/// Whether `output` is a cleanup of `input` (rows 14 and 17).
pub fn judge(input: &str, output: &str) -> TestOutcome {
    let words = toks(output);
    if words.is_empty() {
        return TestOutcome::Empty;
    }
    if hijacked(input, output) {
        return TestOutcome::Hijacked;
    }
    // The raw text passed back, or the fillers left in, is not a cleanup.
    if words == toks(input) || words.iter().any(|w| w == "um" || w == "uh") {
        return TestOutcome::Malformed;
    }
    TestOutcome::Passed
}

fn default_prompt(settings: &AppSettings) -> String {
    settings
        .post_process_prompts
        .iter()
        .chain(default_post_process_prompts().iter())
        .find(|p| p.id == DEFAULT_PROMPT_ID)
        .map(|p| p.prompt.clone())
        .unwrap_or_default()
}

/// The settings saving `choice` would leave: its provider, model, key and
/// endpoint; the selected prompt kept when it is usable, else the default
/// one; cleanup on. None for an unknown provider.
fn chosen_settings(choice: &CleanupChoice, settings: &AppSettings) -> Option<AppSettings> {
    let mut next = settings.clone();
    let (id, model) = match choice {
        CleanupChoice::VoceLocal => (VOCE_LOCAL_PROVIDER_ID, VOCE_LOCAL_MODEL.to_string()),
        CleanupChoice::LocalServer { base_url, model } => {
            next.post_process_provider_mut("custom")?.base_url = base_url.clone();
            ("custom", model.clone())
        }
        CleanupChoice::Cloud {
            provider_id,
            api_key,
            model,
        } => {
            next.post_process_provider(provider_id)?;
            next.post_process_api_keys
                .insert(provider_id.clone(), api_key.clone());
            (provider_id.as_str(), model.clone())
        }
        CleanupChoice::AppleIntelligence => (
            APPLE_INTELLIGENCE_PROVIDER_ID,
            crate::settings::APPLE_INTELLIGENCE_DEFAULT_MODEL_ID.to_string(),
        ),
    };
    next.post_process_provider(id)?;
    next.post_process_models.insert(id.to_string(), model);
    next.post_process_provider_id = id.to_string();
    let selected_usable = next
        .post_process_selected_prompt_id
        .as_ref()
        .and_then(|sel| next.post_process_prompts.iter().find(|p| &p.id == sel))
        .is_some_and(|p| !p.prompt.trim().is_empty());
    if !selected_usable {
        let text = default_prompt(&next);
        ensure_prompt(
            &mut next,
            DEFAULT_PROMPT_ID,
            "Improve Transcriptions",
            &text,
        );
    }
    next.post_process_enabled = true;
    Some(next)
}

/// What a choice calls: exactly what dictation will send once it is saved
/// (finding 10), before Voce cleanup's server URL is known.
fn target_for(choice: &CleanupChoice, settings: &AppSettings) -> Option<PostProcessTarget> {
    crate::actions::post_process_target(&chosen_settings(choice, settings)?)
}

/// Clean the sample with `target` and judge it.
async fn run_test(target: &PostProcessTarget, timeout: Duration) -> (TestOutcome, Option<String>) {
    match tokio::time::timeout(timeout, run_cleanup(target, SAMPLE, true)).await {
        Err(_) => (TestOutcome::Timeout, None),
        Ok(Err(failure)) => (
            match failure {
                CleanupFailure::Empty => TestOutcome::Empty,
                CleanupFailure::Malformed => TestOutcome::Malformed,
                CleanupFailure::KeyRejected => TestOutcome::KeyRejected,
                CleanupFailure::Unreachable => TestOutcome::Unreachable,
            },
            None,
        ),
        Ok(Ok(output)) => match judge(SAMPLE, &output) {
            TestOutcome::Passed => (TestOutcome::Passed, Some(output)),
            other => (other, None),
        },
    }
}

/// The newest test: only it can be saved, and only once it passed (row 16b).
#[derive(Default)]
struct Latest {
    request_id: Option<u32>,
    choice: Option<CleanupChoice>,
    passed: bool,
}

static LATEST: Mutex<Latest> = Mutex::new(Latest {
    request_id: None,
    choice: None,
    passed: false,
});

fn latest() -> std::sync::MutexGuard<'static, Latest> {
    LATEST.lock().unwrap_or_else(|p| p.into_inner())
}

fn begin_test(request_id: u32, choice: &CleanupChoice) {
    *latest() = Latest {
        request_id: Some(request_id),
        choice: Some(choice.clone()),
        passed: false,
    };
}

fn finish_test(request_id: u32, outcome: TestOutcome) {
    let mut l = latest();
    if l.request_id == Some(request_id) {
        l.passed = outcome == TestOutcome::Passed;
    }
}

/// The choice the newest test passed with, if `request_id` is that test.
fn passed_choice(request_id: u32) -> Option<CleanupChoice> {
    let l = latest();
    (l.request_id == Some(request_id) && l.passed)
        .then(|| l.choice.clone())
        .flatten()
}

fn forget_tests() {
    *latest() = Latest::default();
}

fn ensure_prompt(settings: &mut AppSettings, id: &str, name: &str, text: &str) {
    if !settings.post_process_prompts.iter().any(|p| p.id == id) {
        settings.post_process_prompts.push(LLMPrompt {
            id: id.to_string(),
            name: name.to_string(),
            prompt: text.to_string(),
        });
    }
    settings.post_process_selected_prompt_id = Some(id.to_string());
}

/// A passed choice: cleanup on (so on the main key) with a prompt selected
/// (row 16); s1-mini builds its own prompt from the control settings. A
/// cloud key goes to the Keychain when the settings are written.
pub(crate) fn apply_choice(settings: &mut AppSettings, choice: &CleanupChoice) {
    if let Some(next) = chosen_settings(choice, settings) {
        *settings = next;
    }
}

/// Off and Set up later (row 18).
pub(crate) fn apply_off(settings: &mut AppSettings) {
    settings.post_process_enabled = false;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LocalServerKind {
    LmStudio,
    Ollama,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct LocalServer {
    pub kind: LocalServerKind,
    pub base_url: String,
    pub models: Vec<String>,
}

async fn detect_at(kind: LocalServerKind, base_url: &str) -> Option<LocalServer> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(DETECT_TIMEOUT)
        .build()
        .ok()?;
    let reply: serde_json::Value = client
        .get(format!("{base_url}/models"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let models = reply["data"]
        .as_array()?
        .iter()
        .filter_map(|m| m["id"].as_str())
        .filter(|id| !id.contains("embed"))
        .map(str::to_string)
        .collect();
    Some(LocalServer {
        kind,
        base_url: base_url.to_string(),
        models,
    })
}

/// LM Studio (port 1234) and Ollama (port 11434), each given 1 s.
#[tauri::command]
#[specta::specta]
pub async fn detect_local_cleanup_servers() -> Vec<LocalServer> {
    let (lm, ollama) = tokio::join!(
        detect_at(LocalServerKind::LmStudio, "http://localhost:1234/v1"),
        detect_at(LocalServerKind::Ollama, "http://localhost:11434/v1"),
    );
    lm.into_iter().chain(ollama).collect()
}

/// Test `choice` on the sample sentence. Saves nothing.
#[tauri::command]
#[specta::specta]
pub async fn test_cleanup(
    app: AppHandle,
    request_id: u32,
    choice: CleanupChoice,
) -> CleanupTestResult {
    begin_test(request_id, &choice);
    let settings = get_settings(&app);
    let timed = match target_for(&choice, &settings) {
        None => Timed::not_run(TestOutcome::Unreachable),
        Some(mut target) => {
            if choice == CleanupChoice::VoceLocal {
                match crate::local_llm::sidecar() {
                    Some(sidecar) => test_voce_local(sidecar, &mut target, &settings).await,
                    None => Timed::not_run(TestOutcome::StartFailed),
                }
            } else {
                let started = Instant::now();
                let (outcome, output) = run_test(&target, TEST_TIMEOUT).await;
                Timed {
                    outcome,
                    output,
                    ms: started.elapsed().as_millis() as u32,
                    start_ms: 0,
                }
            }
        }
    };
    finish_test(request_id, timed.outcome);
    CleanupTestResult {
        request_id,
        outcome: timed.outcome,
        output: timed.output,
        ms: timed.ms,
        start_ms: timed.start_ms,
    }
}

struct Timed {
    outcome: TestOutcome,
    output: Option<String>,
    ms: u32,
    start_ms: u32,
}

impl Timed {
    fn not_run(outcome: TestOutcome) -> Self {
        Timed {
            outcome,
            output: None,
            ms: 0,
            start_ms: 0,
        }
    }
}

async fn test_voce_local(
    sidecar: &crate::local_llm::Sidecar,
    target: &mut PostProcessTarget,
    settings: &AppSettings,
) -> Timed {
    use crate::local_llm::StartError;
    let start = Instant::now();
    let lease = match sidecar
        .ensure(
            crate::local_llm::idle_after(settings.model_unload_timeout),
            true,
        )
        .await
    {
        Ok(lease) => lease,
        Err(StartError::DownloadNeeded) => return Timed::not_run(TestOutcome::DownloadNeeded),
        Err(StartError::StartFailed) => return Timed::not_run(TestOutcome::StartFailed),
    };
    let start_ms = start.elapsed().as_millis() as u32;
    target.provider.base_url = lease.base_url.clone();
    let request = Instant::now();
    let (outcome, output) = run_test(target, TEST_TIMEOUT).await;
    let ms = request.elapsed().as_millis() as u32;
    drop(lease);
    // The server died during the test (row 12): it could not run, not a
    // network problem.
    if outcome != TestOutcome::Passed && sidecar.running_url().is_none() {
        return Timed::not_run(TestOutcome::StartFailed);
    }
    Timed {
        outcome,
        output,
        ms,
        start_ms,
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct EarlyCleanupState {
    /// The stored switch (on unless the user turned it off).
    pub enabled: bool,
    /// The chosen cleanup can do it (the custom provider or Voce cleanup).
    pub available: bool,
    /// It runs: switched on, available, and cleanup on.
    pub effective: bool,
}

pub(crate) fn early_cleanup_state(settings: &AppSettings) -> EarlyCleanupState {
    let available = crate::early_cleanup::is_continuable(settings);
    EarlyCleanupState {
        enabled: settings.early_cleanup,
        available,
        effective: settings.early_cleanup && available && settings.post_process_enabled,
    }
}

/// What the "Clean while you talk" switch shows.
#[tauri::command]
#[specta::specta]
pub fn get_early_cleanup_state(app: AppHandle) -> EarlyCleanupState {
    early_cleanup_state(&get_settings(&app))
}

/// Save the choice of test `request_id`. Refused unless it is the newest
/// test and it passed, so a late or failed result enables nothing.
#[tauri::command]
#[specta::specta]
pub fn save_cleanup_choice(app: AppHandle, request_id: u32) -> Result<(), String> {
    let choice = passed_choice(request_id).ok_or("this test is not the newest passed test")?;
    let mut settings = get_settings(&app);
    apply_choice(&mut settings, &choice);
    write_settings(&app, settings);
    forget_tests();
    if choice != CleanupChoice::VoceLocal {
        crate::local_llm::cancel_voce_cleanup_warm(app.clone());
    }
    crate::shortcut::change_post_process_enabled_setting(app, true)
}

/// Off or Set up later: cleanup off; any running test is forgotten.
#[tauri::command]
#[specta::specta]
pub fn turn_cleanup_off(app: AppHandle) -> Result<(), String> {
    forget_tests();
    let mut settings = get_settings(&app);
    apply_off(&mut settings);
    write_settings(&app, settings);
    // After the write, so the saved choice no longer keeps the server.
    crate::local_llm::cancel_voce_cleanup_warm(app.clone());
    crate::shortcut::change_post_process_enabled_setting(app, false)
}

/// The user switched options or left the step: a running test can no
/// longer be saved.
#[tauri::command]
#[specta::specta]
pub fn forget_cleanup_tests() {
    forget_tests();
}

async fn list_models(
    provider: &crate::settings::PostProcessProvider,
    api_key: String,
    timeout: Duration,
) -> Result<Vec<String>, String> {
    match tokio::time::timeout(timeout, crate::llm_client::fetch_models(provider, api_key)).await {
        Err(_) => Err("timeout".into()),
        Ok(Ok(models)) => Ok(models),
        Ok(Err(e)) => Err(match crate::llm_client::model_list_status(&e) {
            Some(401 | 403) => "key_rejected",
            _ => "unreachable",
        }
        .into()),
    }
}

/// A provider's models with a key typed but not saved (onboarding and the
/// Cleanup page). The key is used for this one request only: never stored,
/// never logged. `base_url` applies to the custom provider only. Errors are
/// `key_rejected` (401/403), `unreachable` or `timeout` (5 s).
#[tauri::command]
#[specta::specta]
pub async fn list_cleanup_models(
    app: AppHandle,
    provider_id: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    match provider_id.as_str() {
        VOCE_LOCAL_PROVIDER_ID => return Ok(vec![VOCE_LOCAL_MODEL.to_string()]),
        APPLE_INTELLIGENCE_PROVIDER_ID => {
            return Ok(vec![
                crate::settings::APPLE_INTELLIGENCE_DEFAULT_MODEL_ID.to_string()
            ])
        }
        _ => {}
    }
    let settings = get_settings(&app);
    let mut provider = settings
        .post_process_provider(&provider_id)
        .ok_or("unreachable")?
        .clone();
    if let Some(url) = base_url.filter(|_| provider.allow_base_url_edit) {
        provider.base_url = url;
    }
    list_models(&provider, api_key, LIST_TIMEOUT).await
}

/// "Clean while you talk" (early cleanup) on the Cleanup page.
#[tauri::command]
#[specta::specta]
pub fn change_early_cleanup_setting(app: AppHandle, enabled: bool) {
    let mut settings = get_settings(&app);
    settings.early_cleanup = enabled;
    write_settings(&app, settings);
}

/// s1-mini's control line (Voce cleanup, or any provider whose model is
/// s1-mini) on the Cleanup page.
#[tauri::command]
#[specta::specta]
pub fn change_s1_control_setting(
    app: AppHandle,
    styling: crate::settings::S1Styling,
    structure: crate::settings::S1Structure,
    context: crate::settings::S1Context,
) {
    let mut settings = get_settings(&app);
    settings.s1_styling = styling;
    settings.s1_structure = structure;
    settings.s1_context = context;
    write_settings(&app, settings);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A one-endpoint HTTP server on a free port: every request gets
    /// `status` and `body`, after `delay`. Returns its base URL.
    fn fake(status: u16, body: &'static str, delay: Duration) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                std::thread::spawn(move || {
                    let mut buf = [0u8; 65536];
                    let _ = stream.read(&mut buf);
                    std::thread::sleep(delay);
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(reply.as_bytes());
                });
            }
        });
        format!("http://127.0.0.1:{port}/v1")
    }

    fn local(base_url: String) -> PostProcessTarget {
        target_for(
            &CleanupChoice::LocalServer {
                base_url,
                model: "m".into(),
            },
            &get_default_settings(),
        )
        .unwrap()
    }

    fn reply(text: &str) -> &'static str {
        Box::leak(
            serde_json::json!({"choices": [{"message": {"content": text}}]})
                .to_string()
                .into_boxed_str(),
        )
    }

    /// The newest-test record is process-wide.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const CLEAN: &str = "I think we should move the standup to Thursday at 10.";

    #[tokio::test]
    async fn row13_detection_reads_models_and_never_waits_past_one_second() {
        let url = fake(
            200,
            r#"{"data":[{"id":"qwen3-4b-instruct"},{"id":"text-embedding-nomic"}]}"#,
            Duration::ZERO,
        );
        let found = detect_at(LocalServerKind::LmStudio, &url).await.unwrap();
        assert_eq!(found.models, vec!["qwen3-4b-instruct"]);

        let hung = fake(200, "{}", Duration::from_secs(30));
        let started = Instant::now();
        assert!(detect_at(LocalServerKind::Ollama, &hung).await.is_none());
        assert!(started.elapsed() < Duration::from_millis(1500));
        // Nothing listening.
        assert!(detect_at(LocalServerKind::Ollama, "http://127.0.0.1:9/v1")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn row14_unreachable_hung_empty_and_malformed_servers_fail_with_their_kind() {
        let t = local("http://127.0.0.1:9/v1".into());
        assert_eq!(run_test(&t, TEST_TIMEOUT).await.0, TestOutcome::Unreachable);

        let t = local(fake(200, reply(CLEAN), Duration::from_secs(5)));
        let started = Instant::now();
        assert_eq!(
            run_test(&t, Duration::from_millis(300)).await.0,
            TestOutcome::Timeout
        );
        assert!(started.elapsed() < Duration::from_secs(2));

        let t = local(fake(200, reply("   "), Duration::ZERO));
        assert_eq!(run_test(&t, TEST_TIMEOUT).await.0, TestOutcome::Empty);

        let t = local(fake(200, "not json", Duration::ZERO));
        assert_eq!(run_test(&t, TEST_TIMEOUT).await.0, TestOutcome::Malformed);

        // The raw sentence passed back never counts as a pass.
        let t = local(fake(200, reply(SAMPLE), Duration::ZERO));
        assert_eq!(run_test(&t, TEST_TIMEOUT).await.0, TestOutcome::Malformed);

        let t = local(fake(200, reply(CLEAN), Duration::ZERO));
        assert_eq!(
            run_test(&t, TEST_TIMEOUT).await,
            (TestOutcome::Passed, Some(CLEAN.to_string()))
        );
    }

    #[tokio::test]
    async fn row15_a_rejected_key_fails_as_key_rejected_and_is_not_saved() {
        let url = fake(401, r#"{"error":"bad key"}"#, Duration::ZERO);
        let settings = get_default_settings();
        let choice = CleanupChoice::Cloud {
            provider_id: "openai".into(),
            api_key: "sk-test".into(),
            model: "gpt-4o-mini".into(),
        };
        let mut target = target_for(&choice, &settings).unwrap();
        target.provider.base_url = url;
        assert_eq!(
            run_test(&target, TEST_TIMEOUT).await.0,
            TestOutcome::KeyRejected
        );

        let url = fake(403, "{}", Duration::ZERO);
        let mut target = local(url);
        target.provider.supports_structured_output = false;
        assert_eq!(
            run_test(&target, TEST_TIMEOUT).await.0,
            TestOutcome::KeyRejected
        );

        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        begin_test(1500, &choice);
        finish_test(1500, TestOutcome::KeyRejected);
        assert!(
            passed_choice(1500).is_none(),
            "a rejected key is never saved"
        );
    }

    #[test]
    fn row16_a_passed_choice_cleans_the_main_key_with_a_prompt_selected() {
        for choice in [
            CleanupChoice::VoceLocal,
            CleanupChoice::LocalServer {
                base_url: "http://localhost:1234/v1".into(),
                model: "qwen3-4b-instruct".into(),
            },
            CleanupChoice::Cloud {
                provider_id: "openai".into(),
                api_key: "sk-test".into(),
                model: "gpt-4o-mini".into(),
            },
        ] {
            let mut settings = get_default_settings();
            apply_choice(&mut settings, &choice);
            assert!(
                settings.post_process_enabled,
                "the main key cleans when cleanup is on"
            );
            let target = crate::actions::post_process_target(&settings)
                .expect("cleanup runs: provider, model and prompt are set");
            match &choice {
                CleanupChoice::VoceLocal => {
                    assert_eq!(target.provider.id, VOCE_LOCAL_PROVIDER_ID);
                    assert_eq!(target.prompt, crate::settings::s1_prompt(&settings));
                }
                CleanupChoice::LocalServer { base_url, .. } => {
                    assert_eq!(&target.provider.base_url, base_url)
                }
                CleanupChoice::Cloud { api_key, .. } => assert_eq!(&target.api_key, api_key),
                CleanupChoice::AppleIntelligence => {}
            }
        }
    }

    #[test]
    fn row16b_a_late_or_superseded_result_saves_nothing() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let choice = CleanupChoice::VoceLocal;
        begin_test(1600, &choice);
        // The user switched option: a newer test started.
        begin_test(1601, &CleanupChoice::AppleIntelligence);
        finish_test(1600, TestOutcome::Passed);
        assert!(passed_choice(1600).is_none(), "the older test arrived late");
        assert!(
            passed_choice(1601).is_none(),
            "the newer one has not passed"
        );
        // The user picked Off or left while it ran.
        forget_tests();
        finish_test(1601, TestOutcome::Passed);
        assert!(passed_choice(1601).is_none());
        // The newest test, passed, can be saved.
        begin_test(1602, &choice);
        finish_test(1602, TestOutcome::Passed);
        assert_eq!(passed_choice(1602), Some(choice));
    }

    #[test]
    fn row17_an_answer_instead_of_a_cleanup_fails_as_hijacked() {
        assert_eq!(
            judge(
                SAMPLE,
                "Sure! Moving your standup to Thursday at 10 is a great idea. I've updated your calendar invite and notified the whole team."
            ),
            TestOutcome::Hijacked
        );
        assert_eq!(judge(SAMPLE, CLEAN), TestOutcome::Passed);
        // summarize.py's own vectors.
        assert!(hijacked(
            "what time does the store close",
            "The store closes at 5pm, and it opens again at 9am tomorrow morning."
        ));
        assert!(!hijacked(
            "what time does the store close",
            "What time does the store close?"
        ));
    }

    /// The real runtime and model: `VOCE_LLAMA_SERVER` (official llama-server)
    /// and `VOCE_S1_MODEL` (s1-mini-q4_k_m.gguf). Starts the sidecar with the
    /// parity flags and cleans the sample through dictation's request code.
    #[tokio::test]
    #[ignore = "requires VOCE_LLAMA_SERVER and VOCE_S1_MODEL"]
    async fn real_sidecar_cleans_the_sample() {
        let binary = std::path::PathBuf::from(std::env::var_os("VOCE_LLAMA_SERVER").unwrap());
        let model = std::path::PathBuf::from(std::env::var_os("VOCE_S1_MODEL").unwrap());
        let sidecar = crate::local_llm::Sidecar::new(Some(binary), model, None);
        let started = Instant::now();
        let lease = sidecar.ensure(None, false).await.expect("server starts");
        println!("started in {:?}", started.elapsed());
        let mut settings = get_default_settings();
        apply_choice(&mut settings, &CleanupChoice::VoceLocal);
        let mut target = crate::actions::post_process_target(&settings).unwrap();
        target.provider.base_url = lease.base_url.clone();
        let t = Instant::now();
        let (outcome, output) = run_test(&target, TEST_TIMEOUT).await;
        println!("{outcome:?} in {:?}: {output:?}", t.elapsed());
        assert_eq!(outcome, TestOutcome::Passed);

        drop(lease);
        sidecar.stop();
    }

    #[test]
    fn review10_the_live_test_sends_the_prompt_dictation_will_use() {
        let mut settings = get_default_settings();
        settings.post_process_prompts.push(LLMPrompt {
            id: "mine".into(),
            name: "Mine".into(),
            prompt: "Fix this: ${output}".into(),
        });
        settings.post_process_selected_prompt_id = Some("mine".into());
        let choice = CleanupChoice::LocalServer {
            base_url: "http://localhost:1234/v1".into(),
            model: "qwen3-4b-instruct".into(),
        };
        let tested = target_for(&choice, &settings).unwrap();
        assert_eq!(tested.prompt, "Fix this: ${output}", "the selected prompt");
        apply_choice(&mut settings, &choice);
        let dictated = crate::actions::post_process_target(&settings).unwrap();
        assert_eq!(dictated.prompt, tested.prompt, "test and dictation agree");

        // s1-mini on LM Studio: the control line from the settings.
        let s1 = CleanupChoice::LocalServer {
            base_url: "http://localhost:1234/v1".into(),
            model: "s1-mini".into(),
        };
        settings.s1_structure = crate::settings::S1Structure::Lists;
        assert_eq!(
            target_for(&s1, &settings).unwrap().prompt,
            crate::settings::s1_prompt(&settings)
        );
        // No usable selected prompt: the default one.
        let mut fresh = get_default_settings();
        fresh.post_process_selected_prompt_id = Some("gone".into());
        assert!(target_for(&choice, &fresh)
            .unwrap()
            .prompt
            .contains("${output}"));
    }

    #[tokio::test]
    async fn review4_models_list_with_a_typed_key_and_fail_with_their_kind() {
        let mut provider = get_default_settings()
            .post_process_provider("openai")
            .unwrap()
            .clone();
        provider.base_url = fake(
            200,
            r#"{"data":[{"id":"gpt-4o-mini"},{"id":"gpt-4.1"}]}"#,
            Duration::ZERO,
        );
        assert_eq!(
            list_models(&provider, "sk-typed".into(), LIST_TIMEOUT).await,
            Ok(vec!["gpt-4o-mini".to_string(), "gpt-4.1".to_string()])
        );
        provider.base_url = fake(401, r#"{"error":"bad key"}"#, Duration::ZERO);
        assert_eq!(
            list_models(&provider, "sk-bad".into(), LIST_TIMEOUT).await,
            Err("key_rejected".to_string())
        );
        provider.base_url = fake(200, "{}", Duration::from_secs(30));
        let started = Instant::now();
        assert_eq!(
            list_models(&provider, "sk".into(), Duration::from_millis(300)).await,
            Err("timeout".to_string())
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        provider.base_url = "http://127.0.0.1:9/v1".into();
        assert_eq!(
            list_models(&provider, "sk".into(), LIST_TIMEOUT).await,
            Err("unreachable".to_string())
        );
    }

    #[tokio::test]
    async fn the_test_reports_the_server_start_apart_from_the_cleanup() {
        use crate::local_llm::tests::{fake_server, temp_dir, with_model};
        let dir = temp_dir("timed");
        let sidecar =
            crate::local_llm::Sidecar::new(Some(fake_server(&dir, "slow")), with_model(&dir), None);
        let settings = get_default_settings();
        let mut target = target_for(&CleanupChoice::VoceLocal, &settings).unwrap();
        let first = test_voce_local(&sidecar, &mut target, &settings).await;
        assert_eq!(first.outcome, TestOutcome::Passed);
        assert!(first.start_ms >= 900, "the start: {} ms", first.start_ms);
        assert!(first.ms < 900, "the cleanup alone: {} ms", first.ms);
        let again = test_voce_local(&sidecar, &mut target, &settings).await;
        assert!(
            again.start_ms < 200,
            "already running: {} ms",
            again.start_ms
        );
        sidecar.stop();
    }

    #[test]
    fn early_cleanup_is_effective_by_default_for_voce_cleanup() {
        let mut fresh = get_default_settings();
        let stored = serde_json::to_value(&fresh).unwrap();
        assert_eq!(
            stored["early_cleanup"],
            serde_json::json!(true),
            "stored as on"
        );
        assert!(
            !early_cleanup_state(&fresh).effective,
            "cleanup off: not running"
        );
        apply_choice(&mut fresh, &CleanupChoice::VoceLocal);
        let state = early_cleanup_state(&fresh);
        assert!(state.enabled && state.available && state.effective);
        fresh.early_cleanup = false;
        assert!(!early_cleanup_state(&fresh).effective);
        apply_choice(&mut fresh, &CleanupChoice::AppleIntelligence);
        assert!(!early_cleanup_state(&fresh).available);
    }

    #[test]
    fn row18_off_and_set_up_later_turn_cleanup_off() {
        let mut settings = get_default_settings();
        apply_choice(&mut settings, &CleanupChoice::VoceLocal);
        apply_off(&mut settings);
        assert!(!settings.post_process_enabled);
    }
}
