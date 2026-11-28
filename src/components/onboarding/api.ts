// Every backend call the onboarding and the Storage page make goes through
// this one module, so a change in the backend is a one-file change here.
//
// The onboarding commands live in src-tauri/src/onboarding.rs,
// cleanup_setup.rs, local_llm.rs and storage.rs (docs/onboarding-lifecycle.md).
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platform } from "@tauri-apps/plugin-os";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
  requestAccessibilityPermission,
  requestMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import {
  commands,
  events,
  type AppSettings,
  type AppleIntelligenceState,
  type CleanupChoice as BackendChoice,
  type RecordingRetentionPeriod,
} from "@/bindings";

export const STEPS = [
  "welcome",
  "permissions",
  "speech",
  "cleanup",
  "try",
  "names",
  "storage",
  "done",
] as const;
export type OnboardingStep = (typeof STEPS)[number];

export type Permissions = { microphone: boolean; accessibility: boolean };

export type S1Status = {
  state: "missing" | "downloading" | "ready" | "failed";
  downloaded: number; // bytes
  total: number; // bytes
  secondsLeft?: number | null;
};

/** "custom": an OpenAI-compatible server the user typed in (Settings). */
export type LocalServerKind = "lm_studio" | "ollama" | "custom";
export type LocalServer = {
  kind: LocalServerKind;
  baseUrl: string;
  models: string[];
};
export type AppleState = AppleIntelligenceState;
export type CloudProvider = { id: string; label: string; model: string };

export type CleanupChoice =
  | { kind: "s1" }
  | { kind: "local"; server: LocalServerKind; baseUrl: string; model: string }
  | { kind: "cloud"; provider: string; model: string; apiKey: string }
  | { kind: "apple" }
  | { kind: "off" };

// A fresh install saves no model for cloud providers, so a test would ask
// for model "". These are each provider's small, cheap chat models.
// ponytail: fixed ids age as providers retire models; upgrade path is the
// backend listing the provider's models with the typed key.
const DEFAULT_CLOUD_MODELS: Record<string, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-haiku-4-5",
  openrouter: "openai/gpt-4.1-mini",
  groq: "llama-3.1-8b-instant",
  cerebras: "llama3.1-8b",
  zai: "glm-4.5-air",
};
export const defaultCloudModel = (providerId: string) =>
  DEFAULT_CLOUD_MODELS[providerId] ?? "";

export type CleanupTestError =
  | "download_needed"
  | "start_failed" // the bundled server would not start or crashed
  | "unreachable"
  | "timeout"
  | "empty"
  | "malformed"
  | "hijack" // answered the sentence instead of cleaning it
  | "key_rejected"
  | "unknown";

export type CleanupTestResult =
  /** ms: the cleanup request alone; startMs: starting the server first. */
  | { ok: true; ms: number; startMs: number; output: string }
  | { ok: false; error: CleanupTestError };

export type TryEvent =
  | { type: "recording" }
  | { type: "partial"; committed: string; tentative: string }
  | { type: "transcribing" }
  | { type: "finished" } // the overlay closed
  /** Practice mode: the dictation's text; `ms` from key release when the
   *  backend sends it. */
  | { type: "text"; text: string; ms?: number }
  | { type: "cancelled" }
  | { type: "error"; error: "no_speech" | "failed"; detail?: string };

export type S1Control = {
  styling: "casual" | "semi-casual" | "semi-formal" | "formal";
  structure: "prose" | "lists";
  context: "general" | "email";
};

export type ShortcutFailure = { id: string; binding: string; error: string };

export type StorageKind =
  | "speech_model"
  | "meeting_model"
  | "cleanup_model"
  | "runtime"
  | "recordings"
  | "call_data"
  | "history";

export type StorageItem = {
  /** What removeStorageItem takes. */
  id: string;
  kind: StorageKind;
  /** Model name, for models. */
  name: string;
  bytes: number;
  /** Calls or dictations. */
  count: number | null;
  inUse: boolean;
  /** A trash icon is offered only when true (never for a model in use). */
  removable: boolean;
  /** Saved recordings: how long they are kept. */
  retention?: RecordingRetentionPeriod;
};

export type StorageUsage = {
  voceBytes: number;
  diskTotal: number;
  diskFree: number;
  items: StorageItem[];
};

export interface OnboardingApi {
  getStep(): Promise<OnboardingStep>;
  /** Marks `step` done; resolves to the step to show next. */
  completeStep(step: OnboardingStep): Promise<OnboardingStep>;
  checkPermissions(): Promise<Permissions>;
  requestMicrophone(): Promise<void>;
  requestAccessibility(): Promise<void>;
  /** After a denial macOS will not ask again: open the pane in System Settings. */
  openPrivacySettings(kind: keyof Permissions): Promise<void>;
  /** The speech model still downloading when the user moved on. */
  setPendingModel(modelId: string | null): Promise<void>;
  getPendingModel(): Promise<string | null>;
  getS1Status(): Promise<S1Status>;
  /** Resolves when the download ends or is cancelled (the partial file is
   *  kept); progress arrives through onS1Status. */
  downloadS1(): Promise<void>;
  /** Stop a running s1-mini download (and, once the backend has it, a
   *  warm-up): the user picked something else. */
  cancelS1(): Promise<void>;
  /** The saved cleanup: Voce cleanup, something else, or off. */
  savedCleanup(): Promise<"s1" | "other" | "off">;
  onS1Status(cb: (s: S1Status) => void): Promise<() => void>;
  /** Resolves within about 1 s; never blocks the screen. */
  detectLocalServers(): Promise<LocalServer[]>;
  openLocalServerApp(kind: LocalServerKind): Promise<void>;
  /** Whether this Mac can run Apple Intelligence, and whether it is ready. */
  appleState(): Promise<AppleState>;
  cloudProviders(): Promise<CloudProvider[]>;
  /** The provider's models, listed with the typed key (nothing saved). */
  listCloudModels(providerId: string, apiKey: string): Promise<string[]>;
  testCleanup(
    choice: CleanupChoice,
    requestId: number,
  ): Promise<CleanupTestResult>;
  /** Saves the choice whose test `requestId` passed, or turns cleanup off. */
  saveCleanupChoice(choice: CleanupChoice, requestId: number): Promise<void>;
  /** The user switched options or left: a running test can no longer save. */
  forgetCleanupTests(): Promise<void>;
  /** Start Voce cleanup's server in the background (no-op when running). */
  warmS1(): Promise<void>;
  /** "Clean while you talk": stored switch, supported by the saved choice,
   *  and whether it runs. */
  getEarlyCleanup(): Promise<{
    enabled: boolean;
    available: boolean;
    effective: boolean;
  }>;
  /** Settings > Cleanup: "Clean while you talk". */
  setEarlyCleanup(enabled: boolean): Promise<void>;
  /** Settings > Cleanup: s1-mini's Style, Structure and Context. */
  setS1Control(c: S1Control): Promise<void>;
  /** Turns on practice mode; names shortcuts that failed to register. */
  startTry(): Promise<{ failedShortcuts: ShortcutFailure[] }>;
  stopTry(): Promise<void>;
  onTryEvent(cb: (e: TryEvent) => void): Promise<() => void>;
  getNamesEnabled(): Promise<boolean>;
  setNamesEnabled(on: boolean): Promise<void>;
  getStorage(): Promise<StorageUsage>;
  removeStorageItem(id: string): Promise<void>;
  revealDataFolder(): Promise<void>;
}

/** A command's Result, or its error thrown. */
const ok = <T>(
  r: { status: "ok"; data: T } | { status: "error"; error: unknown },
) => {
  if (r.status === "error") throw new Error(String(r.error));
  return r.data;
};

const notWired = (what: string) =>
  Promise.reject(new Error(`${what}: no backend command yet`));

const isMac = () => {
  try {
    return platform() === "macos";
  } catch {
    return false;
  }
};

const settings = async (): Promise<AppSettings> => {
  const r = await commands.getAppSettings();
  if (r.status !== "ok") throw new Error(String(r.error));
  return r.data;
};

// ---- s1-mini: progress comes as model-download-progress under this id ----
const S1_ID = "voce-cleanup-s1-mini";
const s1Listeners = new Set<(s: S1Status) => void>();
const emitS1 = (s: S1Status) => s1Listeners.forEach((cb) => cb(s));
let s1Speed = { t: 0, bytes: 0, bps: 0 };

const toBackendChoice = (c: CleanupChoice): BackendChoice => {
  switch (c.kind) {
    case "s1":
      return { kind: "voce_local" };
    case "local":
      return { kind: "local_server", base_url: c.baseUrl, model: c.model };
    case "cloud":
      return {
        kind: "cloud",
        provider_id: c.provider,
        api_key: c.apiKey,
        model: c.model,
      };
    case "apple":
      return { kind: "apple_intelligence" };
    case "off":
      throw new Error("off is not tested");
  }
};

const retentionOf = (s: AppSettings) => s.recording_retention_period;

const realApi: OnboardingApi = {
  async getStep() {
    return (await commands.getOnboardingState()).step;
  },
  completeStep: (step) => commands.completeOnboardingStep(step),

  async checkPermissions() {
    if (!isMac()) return { microphone: true, accessibility: true };
    const [accessibility, microphone] = await Promise.all([
      checkAccessibilityPermission(),
      checkMicrophonePermission(),
    ]);
    return { microphone, accessibility };
  },
  async requestMicrophone() {
    await requestMicrophonePermission();
  },
  async requestAccessibility() {
    await requestAccessibilityPermission();
  },
  async openPrivacySettings(kind) {
    const pane =
      kind === "microphone" ? "Privacy_Microphone" : "Privacy_Accessibility";
    try {
      await openUrl(
        `x-apple.systempreferences:com.apple.preference.security?${pane}`,
      );
    } catch {
      if (kind === "accessibility") await requestAccessibilityPermission();
      else await requestMicrophonePermission();
    }
  },

  setPendingModel: (modelId) => commands.setOnboardingPendingModel(modelId),
  async getPendingModel() {
    return (await commands.getOnboardingState()).pending_model;
  },

  async getS1Status() {
    const s = await commands.voceCleanupStatus();
    return {
      state: s.downloaded ? "ready" : s.downloading ? "downloading" : "missing",
      downloaded: s.downloaded ? s.total_bytes : s.partial_bytes,
      total: s.total_bytes,
    };
  },
  async downloadS1() {
    s1Speed = { t: 0, bytes: 0, bps: 0 };
    let finished: boolean;
    try {
      finished = ok(await commands.downloadVoceCleanupModel());
    } catch (e) {
      // Another screen started it (the Speech step does, in the
      // background); its progress still reaches every listener.
      if (String(e).includes("already downloading")) return;
      const s = await realApi.getS1Status().catch(() => null);
      emitS1({
        state: "failed",
        downloaded: s?.downloaded ?? 0,
        total: s?.total ?? 0,
      });
      throw e;
    }
    // Cancelled: the partial file stays and picking Voce cleanup resumes it.
    emitS1(await realApi.getS1Status());
    void finished;
  },
  async cancelS1() {
    await Promise.all([
      commands.cancelVoceCleanupDownload(),
      commands.cancelVoceCleanupWarm(),
    ]);
  },
  async savedCleanup() {
    const s = await settings();
    if (!s.post_process_enabled) return "off";
    return s.post_process_provider_id === "voce_local" ? "s1" : "other";
  },
  async onS1Status(cb) {
    s1Listeners.add(cb);
    const off = await listen<{
      model_id: string;
      downloaded: number;
      total: number;
    }>("model-download-progress", (e) => {
      if (e.payload.model_id !== S1_ID) return;
      const { downloaded, total } = e.payload;
      const now = performance.now();
      if (s1Speed.t && now - s1Speed.t > 500) {
        const bps = ((downloaded - s1Speed.bytes) * 1000) / (now - s1Speed.t);
        s1Speed = {
          t: now,
          bytes: downloaded,
          bps: s1Speed.bps ? s1Speed.bps * 0.8 + bps * 0.2 : bps,
        };
      } else if (!s1Speed.t) s1Speed = { t: now, bytes: downloaded, bps: 0 };
      cb({
        state: "downloading",
        downloaded,
        total,
        secondsLeft:
          s1Speed.bps > 0 ? (total - downloaded) / s1Speed.bps : null,
      });
    });
    return () => {
      s1Listeners.delete(cb);
      off();
    };
  },

  async detectLocalServers() {
    const found = await commands.detectLocalCleanupServers();
    return found.map((s) => ({
      kind: s.kind,
      baseUrl: s.base_url,
      models: s.models,
    }));
  },
  // TODO(backend): no command opens LM Studio or Ollama yet.
  openLocalServerApp: () => notWired("openLocalServerApp"),
  appleState: () => commands.appleIntelligenceState(),

  async cloudProviders() {
    const s = await settings();
    return (s.post_process_providers ?? [])
      .filter(
        (p) => !["custom", "apple_intelligence", "voce_local"].includes(p.id),
      )
      .map((p) => ({
        id: p.id,
        label: p.label,
        model: s.post_process_models?.[p.id] ?? "",
      }));
  },

  // The key is used for this one request, never stored (backend 48273fd).
  async listCloudModels(providerId, apiKey) {
    return ok(await commands.listCleanupModels(providerId, apiKey, null));
  },

  async testCleanup(choice, requestId) {
    const r = await commands.testCleanup(requestId, toBackendChoice(choice));
    if (r.outcome === "passed")
      return {
        ok: true,
        ms: r.ms,
        startMs: r.start_ms,
        output: r.output ?? "",
      };
    return {
      ok: false,
      error: r.outcome === "hijacked" ? "hijack" : r.outcome,
    };
  },
  async saveCleanupChoice(choice, requestId) {
    if (choice.kind === "off") ok(await commands.turnCleanupOff());
    else ok(await commands.saveCleanupChoice(requestId));
  },
  forgetCleanupTests: () => commands.forgetCleanupTests(),

  setEarlyCleanup: (enabled) => commands.changeEarlyCleanupSetting(enabled),
  warmS1: () => commands.warmVoceCleanup(),
  getEarlyCleanup: () => commands.getEarlyCleanupState(),
  setS1Control: (c) =>
    commands.changeS1ControlSetting(c.styling, c.structure, c.context),

  // Shortcuts and the paste keyboard normally start after onboarding.
  async startTry() {
    const r = ok(await commands.beginOnboardingTry());
    return { failedShortcuts: r.failed_shortcuts };
  },
  stopTry: () => commands.endOnboardingTry(),
  async onTryEvent(cb) {
    const offs = await Promise.all([
      listen<string>("show-overlay", (e) => {
        if (e.payload === "recording" || e.payload === "streaming")
          cb({ type: "recording" });
        else if (e.payload === "transcribing") cb({ type: "transcribing" });
      }),
      listen("hide-overlay", () => cb({ type: "finished" })),
      // Practice mode: the dictation's text comes here instead of a paste.
      listen<{ text: string; cleaned: boolean; ms?: number }>(
        "onboarding-practice-text",
        (e) => cb({ type: "text", text: e.payload.text, ms: e.payload.ms }),
      ),
      // Streaming models release into the live panel's working state, not
      // the transcribing pill: that is the key release too.
      events.streamPhaseEvent.listen((e) => {
        if (e.payload.phase === "working" && e.payload.kind === "transcribing")
          cb({ type: "transcribing" });
      }),
      listen<string>("overlay-ended", (e) => {
        if (e.payload === "nothing_heard")
          cb({ type: "error", error: "no_speech" });
        else if (e.payload === "cancelled") cb({ type: "cancelled" });
        else if (e.payload === "error") cb({ type: "error", error: "failed" });
      }),
      listen<string>("transcription-error", (e) =>
        cb({ type: "error", error: "failed", detail: e.payload }),
      ),
      events.streamTextEvent.listen((e) =>
        cb({ type: "partial", ...e.payload }),
      ),
    ]);
    return () => offs.forEach((off) => off());
  },

  async getNamesEnabled() {
    return (await settings()).screen_names ?? true;
  },
  setNamesEnabled: (enabled) => commands.changeScreenNamesSetting(enabled),

  async getStorage() {
    const [r, s] = await Promise.all([
      commands.getStorageReport().then(ok),
      settings().catch(() => null),
    ]);
    return {
      voceBytes: r.total_bytes,
      diskFree: r.disk_free_bytes,
      diskTotal: r.disk_total_bytes,
      items: r.items.map((i) => ({
        id: i.id,
        kind: i.kind,
        name: i.name,
        bytes: i.bytes,
        count: i.count,
        inUse: i.in_use,
        removable: i.removable,
        retention: i.kind === "recordings" && s ? retentionOf(s) : undefined,
      })),
    };
  },
  async removeStorageItem(id) {
    ok(await commands.removeStorageItem(id));
  },
  async revealDataFolder() {
    await commands.openAppDataDir();
  },
};

let impl: OnboardingApi = realApi;

const noop = async () => {};
/** Debug preview inside the app: reads stay real; nothing is saved,
 *  downloaded, requested from macOS, or removed. */
const previewApi: OnboardingApi = {
  ...realApi,
  completeStep: async (step) => STEPS[STEPS.indexOf(step) + 1],
  requestMicrophone: noop,
  requestAccessibility: noop,
  openPrivacySettings: noop,
  setPendingModel: noop,
  downloadS1: () => notWired("preview"),
  cancelS1: noop,
  openLocalServerApp: noop,
  testCleanup: async () => ({ ok: false, error: "unknown" }),
  saveCleanupChoice: noop,
  setEarlyCleanup: noop,
  setS1Control: noop,
  warmS1: noop,
  startTry: async () => ({ failedShortcuts: [] }),
  stopTry: noop,
  setNamesEnabled: noop,
  removeStorageItem: () => notWired("preview"),
};

export function setPreviewMode(on: boolean) {
  impl = on ? previewApi : realApi;
}

/** Dev preview only: swap in a fake backend. */
export function setFakeApi(fake: OnboardingApi) {
  impl = fake;
}

export const api: OnboardingApi = new Proxy({} as OnboardingApi, {
  get: (_, key: keyof OnboardingApi) => impl[key],
});
