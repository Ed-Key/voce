// Runs before anything imports Tauri APIs: a stand-in IPC for the browser.
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { FAKE_MODELS } from "./fixtures";

(window as unknown as Record<string, unknown>).__TAURI_OS_PLUGIN_INTERNALS__ = {
  platform: "macos",
  eol: "\n",
  version: "26.0",
  family: "unix",
  os_type: "macos",
  arch: "aarch64",
  exe_extension: "",
};

const q = new URLSearchParams(location.search);
const state = q.get("state") ?? "";
// "stale": reads in the first 800 ms are from before onboarding saved cleanup
// (off, OpenAI); later reads see Voce cleanup on. The page mounts at 1.2 s.
const staleUntil = Date.now() + 800;
const fakeSettings = () => {
  const s = settingsNow();
  if (state === "stale" && Date.now() < staleUntil)
    return {
      ...s,
      post_process_enabled: false,
      post_process_provider_id: "openai",
    };
  return s;
};
const settingsNow = () => ({
  onboarding_completed: false,
  post_process_enabled: state !== "off",
  post_process_provider_id:
    state === "advanced" || state === "prompt"
      ? "custom"
      : state === "apple"
        ? "apple_intelligence"
        : state === "cloudsaved"
          ? "openai"
          : "voce_local",
  post_process_providers: [
    { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1" },
    {
      id: "anthropic",
      label: "Anthropic",
      base_url: "https://api.anthropic.com/v1",
    },
    {
      id: "custom",
      label: "Custom",
      base_url: "http://localhost:1234/v1",
      allow_base_url_edit: true,
    },
    { id: "voce_local", label: "Voce cleanup", base_url: "" },
  ],
  post_process_models: {
    custom: "qwen3-4b-instruct",
    openai: state === "cloudsaved" ? "gpt-4.1" : "",
    anthropic: "",
  },
  post_process_api_keys: {
    custom: state === "advanced" ? "stored" : "",
    openai: state === "cloudsaved" ? "sk-saved-key-1234567890" : "",
  },
  post_process_selected_prompt_id:
    state === "prompt" ? "mine" : "default_improve_transcriptions",
  post_process_prompts: [
    { id: "mine", name: "Mine", prompt: "My own selected prompt." },
    {
      id: "default_improve_transcriptions",
      name: "Improve Transcriptions",
      prompt:
        "Remove filler words and fix punctuation. Keep my wording and tone. Reply with the cleaned text only.",
    },
  ],
  early_cleanup: true,
  s1_styling: "semi-formal",
  s1_structure: "prose",
  s1_context: "general",
  keyboard_implementation: "tauri",
  bindings: {
    transcribe: {
      id: "transcribe",
      name: "Dictate",
      description: "",
      default_binding: "option+space",
      current_binding: "option+space",
    },
    transcribe_with_post_process: {
      id: "transcribe_with_post_process",
      name: "Raw",
      description: "",
      default_binding: "option+shift+space",
      current_binding: "option+shift+space",
    },
  },
});

// Shortcut registration as the backend does it (review 3, finding 4): keys
// another app holds fail; suspend releases Voce's keys; change_binding
// registers the new keys; resume registers the rest, skipping keys Voce
// already holds. Try it reads the failures when it starts or regains focus.
const takenKeys = new Set(
  state === "taken"
    ? ["option+space"]
    : state === "taken2"
      ? ["option+space", "option+shift+space"]
      : [],
);
const keysOf: Record<string, string> = {
  transcribe: "option+space",
  transcribe_with_post_process: "option+shift+space",
};
const held = new Set<string>();
const failures = new Map<string, string>();
const register = (id: string) => {
  if (held.has(id)) return true;
  if (takenKeys.has(keysOf[id])) {
    failures.set(id, keysOf[id]);
    return false;
  }
  held.add(id);
  failures.delete(id);
  return true;
};
Object.keys(keysOf).forEach(register);
(window as unknown as { __failures: () => object[] }).__failures = () =>
  [...failures].map(([id, binding]) => ({ id, binding, error: "taken" }));

let nextId = 1;
// Every command the page sent, for behaviour checks.
const ipc: string[] = [];
(window as unknown as { __ipc: string[] }).__ipc = ipc;
(window as unknown as { __emit: typeof emit }).__emit = emit;
mockIPC(
  (cmd, args) => {
    if (!cmd.startsWith("plugin:"))
      ipc.push(`${cmd} ${JSON.stringify(args ?? {})}`);
    if (cmd === "get_app_settings") return fakeSettings();
    if (cmd === "get_available_models") return FAKE_MODELS;
    if (cmd === "get_current_model") return "";
    if (cmd === "plugin:os|locale") return "en-US";
    if (cmd === "suspend_all_bindings") {
      held.clear();
      return null;
    }
    if (cmd === "resume_all_bindings") {
      Object.keys(keysOf).forEach(register);
      return null;
    }
    if (cmd === "change_binding") {
      const { id, binding } = args as { id: string; binding: string };
      keysOf[id] = binding;
      held.delete(id);
      return register(id)
        ? { success: true, binding: null, error: null }
        : { success: false, binding: null, error: "taken" };
    }
    if (cmd === "plugin:event|listen") return nextId++;
    return null;
  },
  { shouldMockEvents: true },
);
