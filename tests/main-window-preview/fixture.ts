// Invented data for the main window harness. Nothing here is a real person,
// call or recording.

/** A silent 8 kHz WAV of the given length, so players show a real duration. */
function silence(seconds: number): string {
  const rate = 8000;
  const bytes = rate * seconds * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes, true);
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

const at = (daysAgo: number, hour: number, minute: number) => {
  const when = new Date();
  when.setDate(when.getDate() - daysAgo);
  when.setHours(hour, minute, 0, 0);
  return when;
};

const binding = (id: string, name: string, keys: string) => ({
  id,
  name,
  description: name,
  default_binding: keys,
  current_binding: keys,
});

const model = (
  id: string,
  name: string,
  description: string,
  size_mb: number,
  accuracy: number,
  speed: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  description,
  filename: `${id}.gguf`,
  source: { HuggingFace: { repo_id: `example/${id}`, revision: "main" } },
  size_mb,
  is_downloaded: false,
  is_downloading: false,
  partial_size: 0,
  is_directory: false,
  engine_type: "TranscribeCpp",
  accuracy_score: accuracy,
  speed_score: speed,
  supports_translation: false,
  is_recommended: false,
  supported_languages: ["en"],
  supports_language_selection: false,
  is_custom: false,
  supports_streaming: false,
  supports_language_detection: false,
  ...extra,
});

const many = (count: number) =>
  Array.from({ length: count }, (_, i) => `l${i}`);

const MODELS = [
  model(
    "parakeet-unified",
    "Parakeet Unified EN 0.6B",
    "Fast, accurate live English transcription",
    697,
    0.9,
    0.78,
    { is_downloaded: true, supports_streaming: true },
  ),
  model(
    "nemotron",
    "Nemotron Streaming 3.5",
    "Live multilingual transcription across 28 languages",
    716,
    0.82,
    0.84,
    {
      is_recommended: true,
      supports_streaming: true,
      supported_languages: many(28),
    },
  ),
  model(
    "canary",
    "Canary 180M Flash",
    "Tiny and instant, runs well on any hardware",
    208,
    0.88,
    0.98,
    {
      is_recommended: true,
      supports_translation: true,
      supported_languages: ["en", "de", "es", "fr"],
    },
  ),
  model(
    "cohere",
    "Cohere Transcribe",
    "Highest accuracy, 14 languages, slower",
    1600,
    0.92,
    0.62,
    { is_recommended: true, supported_languages: many(14) },
  ),
  model(
    "parakeet-tdt",
    "Parakeet TDT 1.1B",
    "English speech-to-text with token-level timestamps.",
    892,
    0.9,
    0.75,
  ),
  model(
    "parakeet-rnnt",
    "Parakeet RNN-T 1.1B",
    "English speech-to-text with token-level timestamps.",
    892,
    0.9,
    0.75,
  ),
];

const entry = (
  id: number,
  when: Date,
  text: string,
  saved = false,
  file = `rec-${id}.wav`,
) => ({
  id,
  file_name: file,
  timestamp: Math.floor(when.getTime() / 1000),
  saved,
  title: "",
  transcription_text: text,
  post_processed_text: null,
  post_process_prompt: null,
  post_process_requested: false,
});

const HISTORY = [
  entry(
    5,
    at(0, 16, 15),
    "Grocery list for the weekend: oat milk, two lemons, basil, a loaf of sourdough and coffee beans. If the market is out of basil, get parsley instead, and check whether we still have olive oil before buying more.",
  ),
  entry(
    4,
    at(0, 16, 12),
    "Reply to Sam: Thursday afternoon works. I will bring the slides.",
    true,
  ),
  entry(
    3,
    at(0, 16, 11),
    "Reminder to water the plants on the balcony, move the basil into the shade, and check whether the tomato seedlings need a bigger pot before the weekend.",
  ),
  entry(
    2,
    at(5, 9, 42),
    "Draft for the newsletter: the bake sale raised enough for new library books, thanks to everyone who helped.",
  ),
  entry(1, at(5, 9, 30), "Book a table for four on Friday at seven.", true),
  entry(
    0,
    at(6, 18, 5),
    "A long ramble to check folding: the sidebar keeps the model at the bottom, the footer is gone, every page shares one column, and the history list clamps each dictation to three lines so a single long note cannot push everything else off the screen. Clicking the text opens the whole note, and clicking again folds it back, while selecting part of it to copy leaves it as it is.",
  ),
];

const call = (
  id: string,
  title: string,
  daysAgo: number,
  hour: number,
  minute: number,
  mmss: string,
) => {
  const [m, s] = mmss.split(":").map(Number);
  return {
    id,
    title,
    started_at: at(daysAgo, hour, minute).toISOString(),
    active: false,
    mic_state: "stopped",
    mic_gaps: [],
    detected_app: "zoom",
    elapsed_ms: (m * 60 + s) * 1000,
    notes: "",
    system: { samples: 0, sample_rate: 48000, error: null },
    mic_segments: [],
    error: null,
  };
};

const CALLS = [
  call("c1", "Product Sync", 2, 16, 5, "32:10"),
  call("c2", "Design Review", 3, 13, 45, "45:00"),
  call("c3", "Quick Question", 3, 13, 40, "1:30"),
  call("c4", "Quarterly Planning", 3, 11, 0, "90:00"),
  call("c5", "Late Night Debugging", 3, 0, 15, "25:00"),
  call("c6", "Book Club", 5, 14, 0, "78:28"),
  call("c7", "Mentoring Session", 5, 10, 0, "60:00"),
  call("c8", "Study Group", 5, 0, 20, "90:00"),
  call("c9", "Family Call", 6, 21, 0, "40:00"),
  call("c10", "Weekly Catch-up", 6, 18, 30, "48:00"),
  call("c11", "Practice Problem Walkthrough", 6, 15, 30, "23:00"),
  call("c12", "Recipe Swap", 7, 16, 30, "14:00"),
  call("c13", "Coffee Chat", 7, 16, 0, "8:00"),
  call("c14", "Call", 7, 14, 54, "0:09"),
];

export function fixture(
  theme: string,
  /** The saved cleanup provider (default: a custom server). */
  provider = "custom",
  /** apple_intelligence_state's answer. */
  apple = "ready",
) {
  const settings = {
    onboarding_completed: true,
    theme,
    app_language: "en",
    bindings: {
      transcribe: binding("transcribe", "Transcribe", "ctrl+option+shift+d"),
      cancel: binding("cancel", "Cancel", "escape"),
      transcribe_with_post_process: binding(
        "transcribe_with_post_process",
        "Post-process",
        "ctrl+option+shift+space",
      ),
    },
    shortcut_activation: "push_to_talk",
    audio_feedback: false,
    audio_feedback_volume: 1,
    mute_while_recording: false,
    selected_microphone: "default",
    selected_output_device: "default",
    update_checks_enabled: false,
    show_whats_new_on_update: true,
    whats_new_last_seen_version: "0.9.8",
    selected_model: "parakeet-unified",
    start_hidden: false,
    autostart_enabled: false,
    show_tray_icon: true,
    overlay_style: "live",
    overlay_position: "bottom",
    model_unload_timeout: "min5",
    experimental_enabled: false,
    paste_method: "ctrl_v",
    clipboard_handling: "copy_to_clipboard",
    auto_submit: false,
    vad_enabled: true,
    filler_word_removal_enabled: true,
    chinese_script: "as_transcribed",
    custom_words: ["Voce", "Figtree", "Tauri", "Parakeet"],
    append_trailing_space: false,
    history_limit: 500,
    recording_retention_period: "days3",
    post_process_enabled: true,
    post_process_provider_id: provider,
    post_process_providers: [
      {
        id: "custom",
        label: "Custom",
        base_url: "http://localhost:1234/v1",
        allow_base_url_edit: true,
      },
    ],
    post_process_api_keys: {},
    post_process_models: { custom: "s1-mini" },
    post_process_prompts: [
      {
        id: "p1",
        name: "s1-mini (control line, lists)",
        prompt:
          "[Styling: semi-formal] [Structure: lists] [Context: general]\n${output}",
      },
      { id: "p2", name: "Plain cleanup", prompt: "Fix the grammar: ${output}" },
    ],
    post_process_selected_prompt_id: "p1",
    keyboard_implementation: "tauri",
    debug_mode: false,
    call_invitations_enabled: true,
  };

  const audio: Record<string, string> = {
    "rec-5.wav": silence(38),
    "rec-4.wav": silence(6),
    "rec-3.wav": silence(21),
  };

  const replies: Record<string, unknown> = {
    get_app_settings: settings,
    get_default_settings: settings,
    get_onboarding_state: { step: "done", pending_model: null },
    is_update_checks_locked: false,
    get_secure_input_status: { supported: false, active: false },
    get_available_microphones: [
      { index: "0", name: "Default", is_default: true },
    ],
    get_available_output_devices: [
      { index: "0", name: "Default", is_default: true },
    ],
    get_microphone_channels: 1,
    get_available_models: MODELS,
    get_current_model: "parakeet-unified",
    get_transcription_model_status: "parakeet-unified",
    get_history_entries: { entries: HISTORY, has_more: false },
    get_app_dir_path: "/Users/example/Library/Application Support/voce",
    get_log_dir_path: "/Users/example/Library/Logs/voce",
    is_recording: false,
    is_portable: false,
    is_laptop: true,
    check_custom_sounds: { start: false, stop: false },
    get_available_accelerators: {
      transcribe: ["auto"],
      ort: ["auto"],
      gpu_devices: [],
    },
    fetch_post_process_models: ["s1-mini"],
    detect_local_cleanup_servers: [],
    apple_intelligence_state: apple,
    get_early_cleanup_state: {
      enabled: true,
      available: true,
      effective: true,
    },
    list_saved_calls: CALLS,
    call_detection_snapshot: {
      available: true,
      apps: ["discord"],
      possible_end: false,
      dictating: false,
    },
    call_notes_snapshot: null,
    assistie_plugin_status: { running: false, phase: "offline" },
    get_windows_microphone_permission_status: {
      supported: false,
      overall_access: "allowed",
    },
  };

  return { audio, replies };
}
