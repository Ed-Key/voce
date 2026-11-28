#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::audio_feedback::{play_feedback_sound, play_feedback_sound_blocking, SoundType};
use crate::audio_toolkit::{is_microphone_access_denied, is_no_input_device_error, VadPolicy};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::HistoryManager;
use crate::managers::model::ModelManager;
use crate::managers::transcription::StreamWorkKind;
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{
    get_settings, AppSettings, OverlayStyle, PostProcessProvider, APPLE_INTELLIGENCE_PROVIDER_ID,
    RAW_BINDING_ID, VOCE_LOCAL_PROVIDER_ID,
};
use crate::shortcut;
use crate::tray::{set_tray_state, TrayIconState};
use crate::utils::{
    self, show_processing_overlay, show_recording_overlay, show_transcribing_overlay,
    OverlayEndReason,
};
use crate::TranscriptionCoordinator;
use log::{debug, error, info, warn};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::{AppHandle, Emitter};

const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, serde::Serialize)]
struct RecordingErrorEvent {
    error_type: String,
    detail: Option<String>,
}

/// Drop guard that finishes the transcription pipeline, including immediate
/// model unloading on early exits.
struct FinishGuard(AppHandle, Arc<TranscriptionManager>);
impl Drop for FinishGuard {
    fn drop(&mut self) {
        self.1.maybe_unload_immediately("transcription session");
        if let Some(c) = self.0.try_state::<TranscriptionCoordinator>() {
            c.notify_processing_finished();
        }
        // The pipeline just freed its large transient buffers (captured PCM,
        // WAV copy, engine scratch); hand the cached pages back to the OS so
        // they don't sit in malloc arenas until they get swapped out (#1792).
        crate::memory::trim_freed_memory();
    }
}

// Shortcut Action Trait
pub trait ShortcutAction: Send + Sync {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
}

// Transcribe Action
struct TranscribeAction {
    /// The second shortcut: paste without cleanup.
    raw: bool,
}

impl TranscribeAction {
    fn for_binding(binding_id: &str) -> Self {
        Self {
            raw: binding_id == RAW_BINDING_ID,
        }
    }

    /// Whether this dictation cleans: the main key does whenever cleanup is
    /// on; the second shortcut never does (docs/onboarding-lifecycle.md C1).
    fn cleans(&self, settings: &AppSettings) -> bool {
        !self.raw && settings.post_process_enabled
    }
}

/// Field name for structured output JSON schema
const TRANSCRIPTION_FIELD: &str = "transcription";

/// Strip invisible Unicode characters that some LLMs may insert
fn strip_invisible_chars(s: &str) -> String {
    s.replace(['\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}'], "")
}

/// Strip a leading `<think>...</think>` block. Some endpoints can't disable
/// reasoning, and some local servers put the reasoning text into `content`
/// instead of a separate field — without this the user would get the model's
/// chain of thought pasted along with the cleaned transcription.
fn strip_think_block(s: &str) -> &str {
    if let Some(rest) = s.trim_start().strip_prefix("<think>") {
        if let Some(end) = rest.find("</think>") {
            return rest[end + "</think>".len()..].trim_start();
        }
    }
    s
}

/// Build a system prompt from the user's prompt template.
/// Removes `${output}` placeholder since the transcription is sent as the user message.
fn build_system_prompt(prompt_template: &str) -> String {
    prompt_template.replace("${output}", "").trim().to_string()
}

/// Returns `true` when a transcription has no meaningful content to
/// post-process (empty or whitespace-only). Used to skip the post-processing
/// LLM call when nothing was actually transcribed, which would otherwise make
/// the model reply with an error message such as "you need to provide the
/// transcription".
fn is_blank_transcription(transcription: &str) -> bool {
    transcription.trim().is_empty()
}

async fn complete_unless_cancelled<F, C>(operation: F, is_cancelled: C) -> Option<F::Output>
where
    F: Future,
    C: Fn() -> bool,
{
    tokio::pin!(operation);

    loop {
        if is_cancelled() {
            return None;
        }

        if let Ok(result) =
            tokio::time::timeout(CANCELLATION_POLL_INTERVAL, operation.as_mut()).await
        {
            return Some(result);
        }
    }
}

fn should_use_streaming_overlay(style: OverlayStyle, is_streaming: bool) -> bool {
    style == OverlayStyle::Live && is_streaming
}

pub(crate) struct PostProcessTarget {
    pub provider: PostProcessProvider,
    pub api_key: String,
    pub model: String,
    pub prompt: String,
}

/// Provider, model and prompt for post-processing, or None (with the reason
/// logged) when post-processing cannot run with these settings.
pub(crate) fn post_process_target(settings: &AppSettings) -> Option<PostProcessTarget> {
    let provider = match settings.active_post_process_provider().cloned() {
        Some(provider) => provider,
        None => {
            debug!("Post-processing enabled but no provider is selected");
            return None;
        }
    };

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        debug!(
            "Post-processing skipped because provider '{}' has no model configured",
            provider.id
        );
        return None;
    }

    // s1-mini takes its control line from the settings, not an edited prompt.
    if crate::settings::is_s1(&provider.id, &model) {
        let api_key = settings
            .post_process_api_keys
            .get(&provider.id)
            .cloned()
            .unwrap_or_default();
        return Some(PostProcessTarget {
            prompt: crate::settings::s1_prompt(settings),
            provider,
            api_key,
            model,
        });
    }

    let selected_prompt_id = match &settings.post_process_selected_prompt_id {
        Some(id) => id.clone(),
        None => {
            debug!("Post-processing skipped because no prompt is selected");
            return None;
        }
    };

    let prompt = match settings
        .post_process_prompts
        .iter()
        .find(|prompt| prompt.id == selected_prompt_id)
    {
        Some(prompt) => prompt.prompt.clone(),
        None => {
            debug!(
                "Post-processing skipped because prompt '{}' was not found",
                selected_prompt_id
            );
            return None;
        }
    };

    if prompt.trim().is_empty() {
        debug!("Post-processing skipped because the selected prompt is empty");
        return None;
    }

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    Some(PostProcessTarget {
        provider,
        api_key,
        model,
        prompt,
    })
}

/// Why a cleanup request gave no text (the onboarding test's failure kinds;
/// dictation pastes the raw text for any of them).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CleanupFailure {
    Empty,
    Malformed,
    KeyRejected,
    Unreachable,
}

fn failure_of(error: &str) -> CleanupFailure {
    match crate::llm_client::status_of(error) {
        Some(401 | 403) => CleanupFailure::KeyRejected,
        // A reply that is not a chat completion.
        None if error.starts_with("Failed to parse") => CleanupFailure::Malformed,
        _ => CleanupFailure::Unreachable,
    }
}

/// The target ready to call: for Voce cleanup, its server started (on
/// demand) and its URL filled in. The lease keeps the server from being
/// stopped as idle until the request is done.
pub(crate) async fn ready_target(
    settings: &AppSettings,
) -> Option<(PostProcessTarget, Option<crate::local_llm::Lease<'static>>)> {
    let mut target = post_process_target(settings)?;
    if target.provider.id != VOCE_LOCAL_PROVIDER_ID {
        return Some((target, None));
    }
    let sidecar = crate::local_llm::sidecar()?;
    match sidecar
        .ensure(
            crate::local_llm::idle_after(settings.model_unload_timeout),
            false,
        )
        .await
    {
        Ok(lease) => {
            target.provider.base_url = lease.base_url.clone();
            Some((target, Some(lease)))
        }
        Err(e) => {
            warn!("Voce cleanup is unavailable: {:?}", e);
            None
        }
    }
}

pub(crate) async fn post_process_transcription(
    settings: &AppSettings,
    transcription: &str,
) -> Option<String> {
    if is_blank_transcription(transcription) {
        debug!("Post-processing skipped because the transcription is empty");
        return None;
    }
    let (target, _lease) = ready_target(settings).await?;
    run_cleanup(&target, transcription, false).await.ok()
}

/// One cleanup request. `strict` (the onboarding test) fails where dictation
/// is lenient: unparsed structured output and an empty reply are failures
/// there, while dictation keeps today's behavior and pastes what came back.
pub(crate) async fn run_cleanup(
    target: &PostProcessTarget,
    transcription: &str,
    strict: bool,
) -> Result<String, CleanupFailure> {
    let PostProcessTarget {
        provider,
        api_key,
        model,
        prompt,
    } = target;

    debug!(
        "Starting LLM post-processing with provider '{}' (model: {})",
        provider.id, model
    );

    // Ask these providers to skip reasoning/thinking — post-processing rarely
    // benefits from it and it adds seconds of latency. llm_client picks the
    // field the endpoint understands and retries without it if rejected.
    let disable_reasoning = matches!(provider.id.as_str(), "custom" | "openrouter");

    let s1 = crate::settings::is_s1(&provider.id, model);
    if provider.supports_structured_output && !s1 {
        debug!("Using structured outputs for provider '{}'", provider.id);

        let system_prompt = build_system_prompt(prompt);
        let user_content = transcription.to_string();

        // Handle Apple Intelligence separately since it uses native Swift APIs
        if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            {
                if !apple_intelligence::check_apple_intelligence_availability() {
                    debug!(
                        "Apple Intelligence selected but not currently available on this device"
                    );
                    return Err(CleanupFailure::Unreachable);
                }

                let token_limit = model.trim().parse::<i32>().unwrap_or(0);
                return match apple_intelligence::process_text_with_system_prompt(
                    &system_prompt,
                    &user_content,
                    token_limit,
                ) {
                    Ok(result) => {
                        if result.trim().is_empty() {
                            debug!("Apple Intelligence returned an empty response");
                            Err(CleanupFailure::Empty)
                        } else {
                            let result = strip_invisible_chars(&result);
                            debug!(
                                "Apple Intelligence post-processing succeeded. Output length: {} chars",
                                result.len()
                            );
                            Ok(result)
                        }
                    }
                    Err(err) => {
                        error!("Apple Intelligence post-processing failed: {}", err);
                        Err(CleanupFailure::Unreachable)
                    }
                };
            }

            #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
            {
                debug!("Apple Intelligence provider selected on unsupported platform");
                return Err(CleanupFailure::Unreachable);
            }
        }

        // Define JSON schema for transcription output
        let json_schema = serde_json::json!({
            "type": "object",
            "properties": {
                (TRANSCRIPTION_FIELD): {
                    "type": "string",
                    "description": "The cleaned and processed transcription text"
                }
            },
            "required": [TRANSCRIPTION_FIELD],
            "additionalProperties": false
        });

        match crate::llm_client::send_chat_completion_with_schema(
            provider,
            api_key.clone(),
            model,
            user_content,
            Some(system_prompt),
            Some(json_schema),
            disable_reasoning,
        )
        .await
        {
            Ok(Some(content)) => {
                // Parse the JSON response to extract the transcription field
                let content = strip_think_block(&content);
                match serde_json::from_str::<serde_json::Value>(content) {
                    Ok(json) => {
                        if let Some(transcription_value) =
                            json.get(TRANSCRIPTION_FIELD).and_then(|t| t.as_str())
                        {
                            let result = strip_invisible_chars(transcription_value);
                            debug!(
                                "Structured output post-processing succeeded for provider '{}'. Output length: {} chars",
                                provider.id,
                                result.len()
                            );
                            return Ok(result);
                        } else {
                            error!("Structured output response missing 'transcription' field");
                            if strict {
                                return Err(CleanupFailure::Malformed);
                            }
                            return Ok(strip_invisible_chars(content));
                        }
                    }
                    Err(e) => {
                        error!(
                            "Failed to parse structured output JSON: {}. Returning raw content.",
                            e
                        );
                        if strict {
                            return Err(CleanupFailure::Malformed);
                        }
                        return Ok(strip_invisible_chars(content));
                    }
                }
            }
            Ok(None) => {
                error!("LLM API response has no content");
                return Err(CleanupFailure::Empty);
            }
            Err(e) if failure_of(&e) == CleanupFailure::KeyRejected => {
                error!(
                    "Structured output failed for provider '{}': key rejected",
                    provider.id
                );
                return Err(CleanupFailure::KeyRejected);
            }
            Err(e) => {
                warn!(
                    "Structured output failed for provider '{}': {}. Falling back to legacy mode.",
                    provider.id, e
                );
                // Fall through to legacy mode below
            }
        }
    }

    // Legacy mode: Replace ${output} variable in the prompt with the actual text
    let processed_prompt = prompt.replace("${output}", transcription);
    debug!("Processed prompt length: {} chars", processed_prompt.len());
    // s1-mini wants its own system prompt beside the control line.
    let system_prompt = s1.then(|| crate::settings::VOCE_S1_SYSTEM_PROMPT.to_string());

    match crate::llm_client::send_chat_completion_with_schema(
        provider,
        api_key.clone(),
        model,
        processed_prompt,
        system_prompt,
        None,
        disable_reasoning,
    )
    .await
    {
        Ok(Some(content)) => {
            let content = strip_invisible_chars(strip_think_block(&content));
            debug!(
                "LLM post-processing succeeded for provider '{}'. Output length: {} chars",
                provider.id,
                content.len()
            );
            if strict && content.trim().is_empty() {
                return Err(CleanupFailure::Empty);
            }
            Ok(content)
        }
        Ok(None) => {
            error!("LLM API response has no content");
            Err(CleanupFailure::Empty)
        }
        Err(e) => {
            error!(
                "LLM post-processing failed for provider '{}': {}. Falling back to original transcription.",
                provider.id,
                e
            );
            Err(failure_of(&e))
        }
    }
}

/// Minimum gap between two warm-up requests.
const WARM_UP_EVERY: Duration = Duration::from_secs(20);
static LAST_WARM_UP: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);

/// True (and records `now`) when no warm-up was sent in the last WARM_UP_EVERY.
fn warm_up_due(last: &mut Option<Instant>, now: Instant) -> bool {
    if last.is_some_and(|at| now.saturating_duration_since(at) < WARM_UP_EVERY) {
        return false;
    }
    *last = Some(now);
    true
}

/// Make the local cleanup model load now, so the first cleanup does not wait
/// for it. Only for the local custom provider (never a paid cloud API), at most
/// once every WARM_UP_EVERY, fire and forget.
/// Only for a custom provider whose endpoint is on this Mac.
pub(crate) fn warm_post_process_model(settings: &AppSettings) {
    if !settings.post_process_enabled {
        return;
    }
    let Some(target) = post_process_target(settings) else {
        return;
    };
    // Voce cleanup: starting its server is the warm-up (it loads the model).
    if target.provider.id == VOCE_LOCAL_PROVIDER_ID {
        let idle_after = crate::local_llm::idle_after(settings.model_unload_timeout);
        tauri::async_runtime::spawn(async move {
            if let Some(sidecar) = crate::local_llm::sidecar() {
                let _ = sidecar.ensure(idle_after, false).await;
            }
        });
        return;
    }
    // Only a model server on this Mac: a custom provider can also point at a
    // paid cloud API, which must never get unrequested calls.
    if target.provider.id != "custom" || !crate::llm_client::is_loopback(&target.provider.base_url)
    {
        return;
    }
    if !LAST_WARM_UP
        .lock()
        .map(|mut last| warm_up_due(&mut last, Instant::now()))
        .unwrap_or(false)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            crate::llm_client::warm_up(&target.provider, target.api_key, &target.model),
        )
        .await;
        match result {
            Ok(Ok(())) => debug!("Cleanup model warm-up took {:?}", started.elapsed()),
            Ok(Err(e)) => debug!("Cleanup model warm-up failed: {}", e),
            Err(_) => debug!("Cleanup model warm-up timed out"),
        }
    });
}

/// The part of a continuation reply after the prefilled words. llama-server
/// (behind Voce cleanup) sends the prefill back with its continuation, so a
/// Voce reply that does not start with the locked words exactly rewrote them:
/// None, and release falls back to a whole cleanup. LM Studio sends only the
/// rest, so a custom reply is taken as it is.
fn continuation_rest<'a>(provider_id: &str, locked: &str, reply: &'a str) -> Option<&'a str> {
    if provider_id == VOCE_LOCAL_PROVIDER_ID {
        return reply.trim_start().strip_prefix(locked);
    }
    Some(reply)
}

/// Early cleanup's release step: today's legacy request for `transcription`,
/// with `locked` (the start of an earlier cleaned output) as a partial
/// assistant answer, so the model writes only the rest. Returns locked + rest.
async fn post_process_continuing(
    settings: &AppSettings,
    transcription: &str,
    locked: &str,
) -> Option<String> {
    let (target, _lease) = ready_target(settings).await?;
    let prompt = target.prompt.replace("${output}", transcription);
    let system_prompt = crate::settings::is_s1(&target.provider.id, &target.model)
        .then(|| crate::settings::VOCE_S1_SYSTEM_PROMPT.to_string());
    let request = crate::llm_client::send_chat_completion_continuing(
        &target.provider,
        target.api_key.clone(),
        &target.model,
        prompt,
        system_prompt,
        locked.to_string(),
        true,
    );
    match tokio::time::timeout(std::time::Duration::from_secs(20), request).await {
        Ok(Ok(Some(reply))) => {
            let reply = strip_invisible_chars(strip_think_block(&reply));
            let Some(reply) = continuation_rest(&target.provider.id, locked, &reply) else {
                warn!(
                    "Early cleanup continuation rewrote the locked words; using whole-text cleanup"
                );
                return None;
            };
            if reply.trim().is_empty() {
                warn!("Early cleanup continuation returned no text");
                return None;
            }
            let joined = crate::early_cleanup::join(locked, reply);
            if joined.is_none() {
                warn!("Early cleanup continuation started over; using whole-text cleanup");
            }
            joined
        }
        Ok(Ok(None)) => {
            warn!("Early cleanup continuation returned no text");
            None
        }
        Ok(Err(e)) => {
            warn!("Early cleanup continuation failed: {}", e);
            None
        }
        Err(_) => {
            warn!("Early cleanup continuation timed out");
            None
        }
    }
}

pub(crate) struct ProcessedTranscription {
    pub final_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    /// How cleanup ran, for the timing log: "whole", "exact", "cont", or the
    /// reason early cleanup fell back to whole ("no_cache", "not_prefix", ...).
    pub cleanup_path: &'static str,
}

/// `early` is what early cleanup left for this transcription (see
/// early_cleanup::EarlyCleanup::resolve); its settings snapshot, when present,
/// is used so the release request matches the requests made during speech.
pub(crate) async fn process_transcription_output(
    app: &AppHandle,
    transcription: &str,
    post_process: bool,
    early: (crate::early_cleanup::Release, Option<Arc<AppSettings>>),
) -> ProcessedTranscription {
    let (release, early_settings) = early;
    let settings = early_settings.map_or_else(|| get_settings(app), |s| (*s).clone());
    process_with_settings(&settings, transcription, post_process, release).await
}

/// `process_transcription_output` with the settings already chosen.
pub(crate) async fn process_with_settings(
    settings: &AppSettings,
    transcription: &str,
    post_process: bool,
    release: crate::early_cleanup::Release,
) -> ProcessedTranscription {
    use crate::early_cleanup::Release;
    let mut final_text = transcription.to_string();
    let mut post_processed_text: Option<String> = None;
    let mut post_process_prompt: Option<String> = None;
    let mut cleanup_path = "whole";

    if post_process {
        let processed = match release {
            Release::Exact(output) => {
                cleanup_path = "exact";
                Some(output)
            }
            Release::Continue { locked, cache_age } => {
                debug!("Early cleanup: continuing from a cache {:?} old", cache_age);
                match post_process_continuing(&settings, &final_text, &locked).await {
                    Some(text) => {
                        cleanup_path = "cont";
                        Some(text)
                    }
                    None => {
                        cleanup_path = "cont_failed";
                        post_process_transcription(&settings, &final_text).await
                    }
                }
            }
            Release::Whole(reason) => {
                cleanup_path = reason;
                post_process_transcription(&settings, &final_text).await
            }
        };
        if let Some(processed_text) = processed {
            post_processed_text = Some(processed_text.clone());
            final_text = processed_text;

            if let Some(prompt_id) = &settings.post_process_selected_prompt_id {
                if let Some(prompt) = settings
                    .post_process_prompts
                    .iter()
                    .find(|prompt| &prompt.id == prompt_id)
                {
                    post_process_prompt = Some(prompt.prompt.clone());
                }
            }
        }
    }

    ProcessedTranscription {
        final_text,
        post_processed_text,
        post_process_prompt,
        cleanup_path,
    }
}

/// The current dictation's name boosting (docs/boost-lifecycle.md): the
/// list frozen at key-down and why it is or is not boosted.
struct Boost {
    /// "on", or the `boost=off` reason: `empty` (no list), `model` (the
    /// loaded model cannot boost), `stream` (the model does not stream).
    reason: &'static str,
    list: Vec<String>,
}

impl Boost {
    fn off(reason: &'static str) -> Self {
        Boost {
            reason,
            list: Vec::new(),
        }
    }
}

static BOOST: std::sync::Mutex<Option<Boost>> = std::sync::Mutex::new(None);

/// What key-down decided for the current dictation, so release agrees with
/// it even if the settings or onboarding change while the key is held.
#[derive(Clone, Copy)]
struct KeyDown {
    /// Cleanup runs (`TranscribeAction::cleans` on the start-time settings).
    cleans: bool,
    /// Started during onboarding's Try it: the text goes to the practice box
    /// (`onboarding-practice-text`), never pasted into an app (row 23).
    practice: bool,
}

static KEY_DOWN: std::sync::Mutex<Option<KeyDown>> = std::sync::Mutex::new(None);

/// Key-down: freeze the list and decide whether the stream boosts it. A
/// model still loading counts as boosting; the library ignores a list on
/// a model without vocabulary support.
fn boost_for(tm: &TranscriptionManager, settings: &AppSettings) -> Boost {
    boost_decision(
        crate::boost::list::frozen_list(settings),
        tm.is_model_loaded(),
        tm.primary_boosts(),
    )
}

fn boost_decision(list: Vec<String>, loaded: bool, boosts: bool) -> Boost {
    if list.is_empty() {
        Boost::off("empty")
    } else if loaded && !boosts {
        Boost::off("model")
    } else {
        Boost { reason: "on", list }
    }
}

impl ShortcutAction for TranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let start_time = Instant::now();
        debug!("TranscribeAction::start called for binding: {}", binding_id);

        // Load model in the background
        let tm = app.state::<Arc<TranscriptionManager>>();
        let rm = app.state::<Arc<AudioRecordingManager>>();

        // Load ASR model and VAD model in parallel
        let kickoff_started = Instant::now();
        tm.initiate_model_load();
        let rm_clone = Arc::clone(&rm);
        std::thread::spawn(move || {
            if let Err(e) = rm_clone.preload_vad() {
                debug!("VAD pre-load failed: {}", e);
            }
        });
        let kickoff_elapsed = kickoff_started.elapsed();

        // Don't open the mic if nothing can transcribe the recording; the load
        // kicked off above fails and reports why.
        if !tm.is_model_loaded() {
            let selected_model = get_settings(app).selected_model;
            if let Err(e) = app
                .state::<Arc<ModelManager>>()
                .get_model_path(&selected_model)
            {
                warn!("Not starting recording: no model can transcribe it ({})", e);
                return;
            }
        }

        let binding_id = binding_id.to_string();
        let tray_started = Instant::now();
        set_tray_state(app, TrayIconState::Recording);
        let tray_elapsed = tray_started.elapsed();

        // Get the microphone mode to determine audio feedback timing
        let plan_started = Instant::now();
        let settings = get_settings(app);
        let is_always_on = settings.always_on_microphone;
        *KEY_DOWN.lock().unwrap_or_else(|p| p.into_inner()) = Some(KeyDown {
            cleans: self.cleans(&settings),
            practice: crate::onboarding::practice(),
        });

        let selected_model_info = app
            .state::<Arc<ModelManager>>()
            .get_model_info(&settings.selected_model);

        // Use the app-facing model capability as the single pre-recording source
        // for live streaming decisions. Unknown support is represented as false
        // until the model registry is updated by discovery or runtime load.
        let model_supports_streaming = selected_model_info
            .as_ref()
            .map(|m| m.supports_streaming)
            .unwrap_or(false);
        let vad_policy = if !settings.vad_enabled {
            VadPolicy::Disabled
        } else if model_supports_streaming {
            VadPolicy::Streaming
        } else {
            VadPolicy::Offline
        };
        let boost = if model_supports_streaming {
            app.state::<Arc<crate::early_cleanup::EarlyCleanup>>()
                .begin(settings.clone(), self.cleans(&settings));
            // The list is frozen here and bound to this dictation.
            let boost = boost_for(&tm, &settings);
            tm.start_stream(boost.list.clone());
            boost
        } else {
            Boost::off("stream")
        };
        *BOOST.lock().unwrap_or_else(|p| p.into_inner()) = Some(boost);
        let plan_elapsed = plan_started.elapsed();

        // Sizing the overlay follows the same advertised capability. A model that
        // doesn't stream (or whose capability is not known yet) gets the compact
        // pill instead of an oversized transparent live window.
        let overlay_started = Instant::now();
        match settings.overlay_style {
            OverlayStyle::Live if model_supports_streaming => utils::show_streaming_overlay(app),
            OverlayStyle::Live | OverlayStyle::Minimal => show_recording_overlay(app),
            OverlayStyle::None => {} // show_overlay_state no-ops on None anyway
        }
        // Everything above runs before capture can begin, so each span here is
        // added keypress->capture latency.
        debug!(
            "start-path pre-recording steps: model_kickoff={:?} tray={:?} settings+stream_plan={:?} overlay={:?}",
            kickoff_elapsed,
            tray_elapsed,
            plan_elapsed,
            overlay_started.elapsed()
        );
        debug!("Microphone mode - always_on: {}", is_always_on);

        let mut recording_error: Option<String> = None;
        let recording_start_time = Instant::now();
        match rm.try_start_recording(&binding_id, vad_policy) {
            Ok(readiness) => {
                debug!(
                    "Recording request accepted in {:?}; waiting for first microphone samples",
                    recording_start_time.elapsed()
                );
                let generation = readiness.generation();
                let app_clone = app.clone();
                let rm_clone = Arc::clone(&rm);
                std::thread::spawn(move || {
                    if !readiness.wait() {
                        debug!("Microphone readiness wait ended without receiving samples");
                        return;
                    }

                    // Development-only preview hook for evaluating the brief
                    // arming animation on hardware that normally starts too fast
                    // to make it visible.
                    #[cfg(debug_assertions)]
                    if let Ok(delay_ms) = std::env::var("HANDY_DEBUG_MIC_READY_DELAY_MS")
                        .unwrap_or_default()
                        .parse::<u64>()
                    {
                        let delay_ms = delay_ms.min(10_000);
                        if delay_ms > 0 {
                            debug!("Delaying microphone-ready cue by {delay_ms}ms for UI preview");
                            std::thread::sleep(Duration::from_millis(delay_ms));
                        }
                    }

                    if !rm_clone.is_recording_readiness_current(generation) {
                        debug!("Microphone became ready for an inactive recording");
                        return;
                    }

                    debug!("Microphone is receiving samples; recording is ready");
                    utils::emit_recording_ready(&app_clone);

                    // The start chime is a readiness cue, so it must follow the
                    // first real input callback rather than Stream::play() or a
                    // fixed delay. The helper returns immediately when feedback
                    // is disabled; mute still follows the same readiness point.
                    if rm_clone.is_recording_readiness_current(generation) {
                        play_feedback_sound_blocking(&app_clone, SoundType::Start);
                    }
                    if rm_clone.is_recording_readiness_current(generation) {
                        rm_clone.apply_mute();
                    }
                });
            }
            Err(e) => {
                debug!("Failed to start recording: {}", e);
                recording_error = Some(e);
            }
        }

        if recording_error.is_none() {
            // Dynamically register the cancel shortcut in a separate task to avoid deadlock
            shortcut::register_cancel_shortcut(app);
            // Recording is running: now load the cleanup model in the background.
            if self.cleans(&settings) {
                warm_post_process_model(&settings);
            }
        } else {
            // Starting failed (for example due to blocked microphone permissions).
            // Revert UI state so we don't stay stuck in the recording overlay.
            tm.cancel_stream();
            BOOST.lock().unwrap_or_else(|p| p.into_inner()).take();
            utils::end_recording_overlay(app, OverlayEndReason::Error);
            set_tray_state(app, TrayIconState::Idle);
            if let Some(err) = recording_error {
                let error_type = if is_microphone_access_denied(&err) {
                    "microphone_permission_denied"
                } else if is_no_input_device_error(&err) {
                    "no_input_device"
                } else {
                    "unknown"
                };
                let _ = app.emit(
                    "recording-error",
                    RecordingErrorEvent {
                        error_type: error_type.to_string(),
                        detail: Some(err),
                    },
                );
            }
        }

        debug!(
            "TranscribeAction::start completed in {:?}",
            start_time.elapsed()
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        // Prevent a slow microphone from emitting a ready event or start chime
        // after the user has already requested stop.
        app.state::<Arc<AudioRecordingManager>>()
            .invalidate_recording_readiness();

        // Unregister the cancel shortcut when transcription stops
        shortcut::unregister_cancel_shortcut(app);

        let stop_time = Instant::now();
        let key_up = crate::transcription_coordinator::key_up_for(stop_time);
        debug!("TranscribeAction::stop called for binding: {}", binding_id);

        let ah = app.clone();
        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());

        set_tray_state(app, TrayIconState::Transcribing);
        // Stop should give immediate visual feedback. Live streaming can keep
        // the larger panel, but it still switches from listening to a working
        // spinner while the stream finalizes. Non-streaming paths use the
        // compact transcribing pill (None no-ops in show_*).
        let style = get_settings(app).overlay_style;
        // Capture this before finalizing the stream so every later working state
        // targets the same overlay that was shown for this transcription.
        let use_streaming_overlay = should_use_streaming_overlay(style, tm.is_streaming());
        if use_streaming_overlay {
            tm.emit_stream_working(StreamWorkKind::Transcribing);
        } else {
            show_transcribing_overlay(app);
        }

        // Unmute before playing audio feedback so the stop sound is audible
        rm.remove_mute();

        // Play audio feedback for recording stop
        play_feedback_sound(app, SoundType::Stop);

        let binding_id = binding_id.to_string(); // Clone binding_id for the async task
                                                 // The start-time decision holds, so start and release agree.
        let key_down = KEY_DOWN
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
            .unwrap_or_else(|| KeyDown {
                cleans: self.cleans(&get_settings(app)),
                practice: false,
            });
        let post_process = key_down.cleans;
        let cancel_generation = rm.cancel_generation();
        let early = Arc::clone(&app.state::<Arc<crate::early_cleanup::EarlyCleanup>>());
        // Release: no new early cleanup requests from here on.
        early.close();
        let boost = BOOST
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
            .unwrap_or_else(|| Boost::off("stream"));

        tauri::async_runtime::spawn(async move {
            let _guard = FinishGuard(ah.clone(), Arc::clone(&tm));
            debug!(
                "Starting async transcription task for binding: {}",
                binding_id
            );

            let stop_recording_time = Instant::now();
            if let Some(samples) = rm.stop_recording(&binding_id, cancel_generation) {
                let stop_rec_d = stop_recording_time.elapsed();
                debug!(
                    "Recording stopped and samples retrieved in {:?}, sample count: {}",
                    stop_recording_time.elapsed(),
                    samples.len()
                );

                if rm.was_cancelled_since(cancel_generation) {
                    debug!("Transcription operation cancelled after recording stop");
                    tm.cancel_stream();
                    utils::end_recording_overlay(&ah, OverlayEndReason::Cancelled);
                    set_tray_state(&ah, TrayIconState::Idle);
                    return;
                }

                if samples.is_empty() {
                    debug!("Recording produced no audio samples; skipping persistence");
                    // Tear down any streaming worker so its channel doesn't leak
                    // and block the next start_stream.
                    tm.cancel_stream();
                    utils::end_recording_overlay(&ah, OverlayEndReason::NothingHeard);
                    set_tray_state(&ah, TrayIconState::Idle);
                } else {
                    // Save WAV concurrently with transcription
                    let sample_count = samples.len();
                    let file_name = format!("handy-{}.wav", chrono::Utc::now().timestamp());
                    let wav_path = hm.recordings_dir().join(&file_name);
                    let wav_path_for_verify = wav_path.clone();
                    let samples_for_wav = samples.clone();
                    let wav_handle = tauri::async_runtime::spawn_blocking(move || {
                        crate::audio_toolkit::save_wav_file(&wav_path, &samples_for_wav)
                    });

                    // Transcribe concurrently with WAV save. If a live stream was
                    // running, finalize it and use its text (all audio was already
                    // fed to the stream); otherwise batch-transcribe the samples.
                    let transcription_time = Instant::now();
                    let audio_s = sample_count as f32 / 16_000.0;
                    let mut streamed = false;
                    let transcription_result = match tm.finalize_stream() {
                        // A finalized stream with usable text wins. An empty result
                        // (no active stream, produced nothing, or a finalize error
                        // after the engine was returned) falls back to a full batch
                        // transcription of the same audio. A finalize timeout is
                        // surfaced instead — the worker may still hold the engine,
                        // so a batch fallback would contend with it.
                        Ok(Some(text)) if !text.trim().is_empty() => {
                            streamed = true;
                            Ok(text)
                        }
                        // Batch fallback boosts the same list offline.
                        Ok(_) => tm.transcribe_with_vocabulary(samples, &boost.list),
                        Err(err) => Err(err),
                    };
                    let asr_d = transcription_time.elapsed();

                    // Await WAV save and verify
                    let wav_wait_time = Instant::now();
                    let wav_saved = match wav_handle.await {
                        Ok(Ok(())) => {
                            match crate::audio_toolkit::verify_wav_file(
                                &wav_path_for_verify,
                                sample_count,
                            ) {
                                Ok(()) => true,
                                Err(e) => {
                                    error!("WAV verification failed: {}", e);
                                    false
                                }
                            }
                        }
                        Ok(Err(e)) => {
                            error!("Failed to save WAV file: {}", e);
                            false
                        }
                        Err(e) => {
                            error!("WAV save task panicked: {}", e);
                            false
                        }
                    };
                    let wav_wait_d = wav_wait_time.elapsed();

                    if rm.was_cancelled_since(cancel_generation) {
                        debug!("Transcription operation cancelled before output handling");
                        utils::end_recording_overlay(&ah, OverlayEndReason::Cancelled);
                        set_tray_state(&ah, TrayIconState::Idle);
                        return;
                    }

                    match transcription_result {
                        Ok(transcription) => {
                            debug!(
                                "Transcription completed in {:?}: '{}'",
                                transcription_time.elapsed(),
                                utils::redact_text(&transcription)
                            );

                            if post_process {
                                if use_streaming_overlay {
                                    tm.emit_stream_working(StreamWorkKind::Polishing);
                                } else {
                                    show_processing_overlay(&ah);
                                }
                            }
                            let cleanup_time = Instant::now();
                            let early_release = if streamed {
                                early.resolve(&transcription)
                            } else {
                                early.cancel();
                                (crate::early_cleanup::Release::Whole("batch"), None)
                            };
                            let Some(processed) = complete_unless_cancelled(
                                process_transcription_output(
                                    &ah,
                                    &transcription,
                                    post_process,
                                    early_release,
                                ),
                                || rm.was_cancelled_since(cancel_generation),
                            )
                            .await
                            else {
                                debug!("Transcription operation cancelled during output handling");
                                utils::end_recording_overlay(&ah, OverlayEndReason::Cancelled);
                                set_tray_state(&ah, TrayIconState::Idle);
                                return;
                            };
                            let cleanup_d = cleanup_time.elapsed();

                            if rm.was_cancelled_since(cancel_generation) {
                                debug!("Transcription operation cancelled before paste");
                                utils::end_recording_overlay(&ah, OverlayEndReason::Cancelled);
                                set_tray_state(&ah, TrayIconState::Idle);
                                return;
                            }

                            // Save to history if WAV was saved
                            let history_time = Instant::now();
                            if wav_saved {
                                if let Err(err) = hm.save_entry(
                                    file_name,
                                    transcription,
                                    post_process,
                                    processed.post_processed_text.clone(),
                                    processed.post_process_prompt.clone(),
                                ) {
                                    error!("Failed to save history entry: {}", err);
                                }
                            }
                            let history_d = history_time.elapsed();

                            if processed.final_text.is_empty() {
                                utils::end_recording_overlay(&ah, OverlayEndReason::NothingHeard);
                                set_tray_state(&ah, TrayIconState::Idle);
                            } else if key_down.practice {
                                // Try it: to the practice box, never into an app.
                                let text = crate::boost::list::restore_spelling(
                                    &processed.final_text,
                                    &boost.list,
                                    &get_settings(&ah).custom_words,
                                );
                                utils::hide_recording_overlay(&ah);
                                set_tray_state(&ah, TrayIconState::Idle);
                                if !rm.was_cancelled_since(cancel_generation) {
                                    crate::onboarding::emit_practice_text(
                                        &ah,
                                        text,
                                        processed.post_processed_text.is_some(),
                                    );
                                }
                            } else {
                                let ah_clone = ah.clone();
                                let paste_time = Instant::now();
                                // Cleanup may write a listed name differently.
                                let final_text = crate::boost::list::restore_spelling(
                                    &processed.final_text,
                                    &boost.list,
                                    &get_settings(&ah).custom_words,
                                );
                                let boost_field = if boost.reason == "on" {
                                    "on".to_string()
                                } else {
                                    format!("off:{}", boost.reason)
                                };
                                let boost_terms = boost.list.len();
                                let cleanup_path = processed.cleanup_path;
                                let rm_for_paste = Arc::clone(&rm);
                                let wait_for_paste = ah.config().identifier == crate::APP_ID;
                                let (paste_done, pasted) = tokio::sync::oneshot::channel::<()>();
                                ah.run_on_main_thread(move || {
                                    if rm_for_paste.was_cancelled_since(cancel_generation) {
                                        debug!("Transcription operation cancelled before paste");
                                        utils::end_recording_overlay(&ah_clone, OverlayEndReason::Cancelled);
                                        set_tray_state(&ah_clone, TrayIconState::Idle);
                                        let _ = paste_done.send(());
                                        return;
                                    }

                                    let paste_queue_d = paste_time.elapsed();
                                    match utils::paste(final_text, ah_clone.clone()) {
                                        Ok(()) => {
                                            let ms = |d: std::time::Duration| d.as_millis();
                                            // One line per dictation for measuring release-to-paste.
                                            // total starts at stop(), i.e. after the 50 ms RELEASE_GRACE;
                                            // keyup_ms at the key-up itself.
                                            info!(
                                                "dictation_timing total_ms={} keyup_ms={} stop_rec_ms={} asr_ms={} wav_wait_ms={} cleanup_ms={} history_ms={} paste_queue_ms={} paste_ms={} audio_s={:.1} streamed={} post_process={} cleanup_path={} boost={} terms={}",
                                                ms(stop_time.elapsed()),
                                                ms(key_up.elapsed()),
                                                ms(stop_rec_d),
                                                ms(asr_d),
                                                ms(wav_wait_d),
                                                ms(cleanup_d),
                                                ms(history_d),
                                                ms(paste_queue_d),
                                                ms(paste_time.elapsed() - paste_queue_d),
                                                audio_s,
                                                streamed,
                                                post_process,
                                                cleanup_path,
                                                boost_field,
                                                boost_terms
                                            );
                                        }
                                        Err(e) => {
                                            error!("Failed to paste transcription: {}", e);
                                            let _ = ah_clone.emit("paste-error", ());
                                        }
                                    }
                                    utils::hide_recording_overlay(&ah_clone);
                                    set_tray_state(&ah_clone, TrayIconState::Idle);
                                    let _ = paste_done.send(());
                                })
                                .unwrap_or_else(|e| {
                                    error!("Failed to run paste on main thread: {:?}", e);
                                    utils::hide_recording_overlay(&ah);
                                    set_tray_state(&ah, TrayIconState::Idle);
                                });
                                // Keep the dev call worker paused through queued paste completion.
                                if wait_for_paste {
                                    let _ = pasted.await;
                                }
                            }
                        }
                        Err(err) => {
                            if rm.was_cancelled_since(cancel_generation) {
                                debug!(
                                    "Transcription operation cancelled after transcription error"
                                );
                                utils::end_recording_overlay(&ah, OverlayEndReason::Cancelled);
                                set_tray_state(&ah, TrayIconState::Idle);
                                return;
                            }

                            early.cancel();
                            error!("Transcription failed: {}", err);
                            // Surface the failure to the UI (toast). The full
                            // message is also in handy.log via the line above.
                            let _ = ah.emit("transcription-error", err.to_string());
                            // Save entry with empty text so user can retry
                            if wav_saved {
                                if let Err(save_err) = hm.save_entry(
                                    file_name,
                                    String::new(),
                                    post_process,
                                    None,
                                    None,
                                ) {
                                    error!("Failed to save failed history entry: {}", save_err);
                                }
                            }
                            utils::end_recording_overlay(&ah, OverlayEndReason::Error);
                            set_tray_state(&ah, TrayIconState::Idle);
                        }
                    }
                }
            } else {
                debug!("No samples retrieved from recording stop");
                // Tear down any streaming worker so its channel doesn't leak.
                tm.cancel_stream();
                // A cancel also leaves no samples; say so rather than "nothing heard".
                let reason = if rm.was_cancelled_since(cancel_generation) {
                    OverlayEndReason::Cancelled
                } else {
                    OverlayEndReason::NothingHeard
                };
                utils::end_recording_overlay(&ah, reason);
                set_tray_state(&ah, TrayIconState::Idle);
            }
        });

        debug!(
            "TranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
    }
}

// Cancel Action
struct CancelAction;

impl ShortcutAction for CancelAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        utils::cancel_current_operation(app);
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on stop for cancel
    }
}

// Test Action
struct TestAction;

impl ShortcutAction for TestAction {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Started - {} (App: {})", // Changed "Pressed" to "Started" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Stopped - {} (App: {})", // Changed "Released" to "Stopped" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }
}

// Static Action Map
pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "transcribe".to_string(),
        Arc::new(TranscribeAction::for_binding("transcribe")) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        RAW_BINDING_ID.to_string(),
        Arc::new(TranscribeAction::for_binding(RAW_BINDING_ID)) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "cancel".to_string(),
        Arc::new(CancelAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "test".to_string(),
        Arc::new(TestAction) as Arc<dyn ShortcutAction>,
    );
    map
});

#[cfg(test)]
mod warm_up_tests {
    use super::*;

    #[test]
    fn warm_up_is_sent_at_most_once_per_window() {
        let mut last = None;
        let t = Instant::now();
        assert!(warm_up_due(&mut last, t));
        assert!(!warm_up_due(&mut last, t + Duration::from_secs(5)));
        assert!(!warm_up_due(
            &mut last,
            t + WARM_UP_EVERY - Duration::from_millis(1)
        ));
        assert!(warm_up_due(&mut last, t + WARM_UP_EVERY));
    }
}

#[cfg(test)]
mod main_key_tests {
    use super::TranscribeAction;
    use crate::settings::get_default_settings;

    #[test]
    fn early_cleanup_takes_only_the_rest_of_a_reply_that_echoes_the_prefill() {
        use super::continuation_rest;
        let locked = "So I think we should move the standup";
        let echoed = "So I think we should move the standup to Thursday at 10.";
        let rest = continuation_rest("voce_local", locked, echoed).unwrap();
        assert_eq!(rest, " to Thursday at 10.");
        assert_eq!(
            crate::early_cleanup::join(locked, rest).as_deref(),
            Some("So I think we should move the standup to Thursday at 10.")
        );
        // LM Studio sends only the rest; a custom reply is never cut.
        assert_eq!(continuation_rest("custom", locked, echoed), Some(echoed));
        // A Voce reply that rewrote the locked words falls back to whole.
        let rewritten = "I think we should move the standup to Thursday.";
        assert_eq!(continuation_rest("voce_local", locked, rewritten), None);
    }

    #[test]
    fn c1_the_main_key_cleans_when_cleanup_is_on_and_the_second_key_never_does() {
        let main = TranscribeAction { raw: false };
        let raw = TranscribeAction { raw: true };
        let mut settings = get_default_settings();
        assert!(!main.cleans(&settings), "cleanup off: nothing cleans");
        settings.post_process_enabled = true;
        assert!(main.cleans(&settings), "row 16: Option+Space cleans");
        assert!(!raw.cleans(&settings), "the second key pastes raw");
    }

    /// Finding 1 (review, C1): `--toggle-post-process` and macOS SIGUSR1 keep
    /// their meaning after the second shortcut became "without cleanup".
    #[test]
    fn c1_external_cleanup_triggers_still_clean_when_cleanup_is_on() {
        use crate::signal_handle::cli_binding;
        let mut on = get_default_settings();
        on.post_process_enabled = true;
        let off = get_default_settings();
        let cli = cli_binding(&["voce".into(), "--toggle-post-process".into()]).unwrap();
        let mut entries = vec![("--toggle-post-process", cli)];
        #[cfg(target_os = "macos")]
        entries.push((
            "SIGUSR1",
            crate::signal_handle::signal_binding(signal_hook::consts::SIGUSR1)
                .unwrap()
                .0,
        ));
        for (entry, binding) in entries {
            assert!(super::ACTION_MAP.contains_key(binding), "{entry}");
            let action = TranscribeAction::for_binding(binding);
            assert!(action.cleans(&on), "{entry} cleans when cleanup is on");
            assert!(!action.cleans(&off), "{entry} is raw when cleanup is off");
        }
        let main = cli_binding(&["voce".into(), "--toggle-transcription".into()]);
        assert_eq!(main, Some("transcribe"));
        assert_eq!(cli_binding(&["voce".into(), "--cancel".into()]), None);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        complete_unless_cancelled, is_blank_transcription, should_use_streaming_overlay,
        strip_think_block,
    };
    use crate::settings::OverlayStyle;
    use std::future;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn blank_transcription_is_detected() {
        assert!(is_blank_transcription(""));
        assert!(is_blank_transcription("   "));
        assert!(is_blank_transcription("\t\n  \r\n"));
    }

    #[test]
    fn non_blank_transcription_is_kept() {
        assert!(!is_blank_transcription("hello"));
        assert!(!is_blank_transcription("  hello  "));
    }

    #[test]
    fn completed_operation_returns_its_output() {
        let result = tauri::async_runtime::block_on(complete_unless_cancelled(
            future::ready("done"),
            || false,
        ));

        assert_eq!(result, Some("done"));
    }

    #[test]
    fn pending_operation_stops_after_cancellation() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_for_thread = Arc::clone(&cancelled);
        let cancel_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(10));
            cancelled_for_thread.store(true, Ordering::Release);
        });

        let result = tauri::async_runtime::block_on(complete_unless_cancelled(
            future::pending::<()>(),
            || cancelled.load(Ordering::Acquire),
        ));

        cancel_thread.join().unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn leading_think_block_is_stripped() {
        assert_eq!(
            strip_think_block("<think>pondering...</think>Cleaned text."),
            "Cleaned text."
        );
        assert_eq!(
            strip_think_block("  \n<think>multi\nline</think>\n  Cleaned text."),
            "Cleaned text."
        );
    }

    #[test]
    fn content_without_think_block_is_unchanged() {
        assert_eq!(strip_think_block("Cleaned text."), "Cleaned text.");
        assert_eq!(
            strip_think_block("Mentions <think> mid-sentence."),
            "Mentions <think> mid-sentence."
        );
        // Unclosed block: leave untouched rather than guess
        assert_eq!(
            strip_think_block("<think>never closed"),
            "<think>never closed"
        );
    }

    #[test]
    fn live_overlay_uses_streaming_states_only_for_streaming_models() {
        assert!(should_use_streaming_overlay(OverlayStyle::Live, true));
        assert!(!should_use_streaming_overlay(OverlayStyle::Live, false));
        assert!(!should_use_streaming_overlay(OverlayStyle::Minimal, true));
        assert!(!should_use_streaming_overlay(OverlayStyle::None, true));
    }
}

#[cfg(test)]
mod boost_tests {
    use super::boost_decision;

    fn list() -> Vec<String> {
        vec!["QuillPad".to_string()]
    }

    #[test]
    fn boost_row1_a_boosting_model_gets_the_frozen_list() {
        let b = boost_decision(list(), true, true);
        assert_eq!((b.reason, b.list), ("on", list()));
    }

    #[test]
    fn boost_row2_no_list_means_no_boost() {
        let b = boost_decision(Vec::new(), true, true);
        assert_eq!((b.reason, b.list.len()), ("empty", 0));
    }

    #[test]
    fn boost_row3_a_model_that_cannot_boost_gets_no_list() {
        let b = boost_decision(list(), true, false);
        assert_eq!((b.reason, b.list.len()), ("model", 0));
    }

    #[test]
    fn boost_row4_a_model_still_loading_gets_the_list() {
        // The stream starts once the load ends; the library ignores the list
        // if the model turns out not to support vocabulary.
        let b = boost_decision(list(), false, false);
        assert_eq!(b.reason, "on");
    }
}
