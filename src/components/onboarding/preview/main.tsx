// Dev-only: renders one onboarding step in a chosen state against a fake
// backend, for side-by-side checks with the mockup shots.
import "./setup";
import React from "react";
import ReactDOM from "react-dom/client";
import "@/App.css";
import "@/i18n";
import "../onboarding.css";
import { useModelStore } from "@/stores/modelStore";
import { Sidebar } from "@/components/Sidebar";
import { CleanupSettings, StorageSettings } from "@/components/settings";
import Onboarding from "../Onboarding";
import Names from "../Names";
import {
  setFakeApi,
  type OnboardingApi,
  type OnboardingStep,
  type StorageItem,
  type S1Status,
  type TryEvent,
} from "../api";
import { CACHED_MODELS, FAKE_MODELS } from "./fixtures";

const q = new URLSearchParams(location.search);
const step = (q.get("step") ?? "welcome") as OnboardingStep;
const state = q.get("state") ?? "";
if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme")!;

const never = new Promise<never>(() => {});
// Calls the fake backend received, for behaviour checks.
const calls: string[] = [];
(window as unknown as { __calls: string[] }).__calls = calls;
const log = (...a: unknown[]) => {
  calls.push(a.join(" "));
};
const noop = async () => {};
const CLEAN = "I think we should move the standup to Thursday at 10.";
let tryCb: ((e: TryEvent) => void) | null = null;
(window as unknown as { __try: (e: TryEvent) => void }).__try = (e) =>
  tryCb?.(e);

const s1Status = (): S1Status =>
  state === "s1-downloading"
    ? {
        state: "downloading",
        downloaded: 278e6,
        total: 480e6,
        secondsLeft: 15,
      }
    : state === "s1-download-failed"
      ? { state: "failed", downloaded: 212e6, total: 480e6 }
      : q.get("s1") === "missing"
        ? { state: "missing", downloaded: 0, total: 480e6 }
        : { state: "ready", downloaded: 480e6, total: 480e6 };

const fake: OnboardingApi = {
  getStep: async () => (q.get("saved") as OnboardingStep | null) ?? step,
  completeStep: async (s) => s,
  forgetCleanupTests: noop,
  checkPermissions: async () =>
    state === "granted"
      ? { microphone: true, accessibility: true }
      : state === "waiting"
        ? { microphone: true, accessibility: false }
        : { microphone: false, accessibility: false },
  requestMicrophone: noop,
  requestAccessibility: noop,
  openPrivacySettings: noop,
  setPendingModel: noop,
  getPendingModel: async () =>
    (step === "try" || step === "cleanup") &&
    (state === "downloading" || state === "stopped")
      ? "p-unified"
      : null,
  // slowcheck=1: status reads take 1.5 s (a check still pending).
  getS1Status: async () => {
    if (q.get("slowcheck")) await new Promise((r) => setTimeout(r, 1500));
    return s1Status();
  },
  cancelS1: async () => log("cancelS1"),
  // "savedother": cleanup was saved as something other than Voce cleanup.
  savedCleanup: async () => (state === "savedother" ? "other" : "off"),
  downloadS1: () => {
    log("downloadS1");
    return never;
  },
  onS1Status: async () => () => {},
  detectLocalServers: async () => [
    {
      kind: "lm_studio",
      baseUrl: "http://localhost:1234/v1",
      models: ["qwen3-4b-instruct", "gemma-3-4b"],
    },
  ],
  openLocalServerApp: noop,
  // A fresh install: no model saved for any cloud provider.
  cloudProviders: async () => [
    {
      id: "openai",
      label: "OpenAI",
      model: state === "cloudsaved" ? "gpt-4.1" : "",
    },
    { id: "anthropic", label: "Anthropic", model: "" },
  ],
  // "models": the providers list their models; otherwise listing fails.
  listCloudModels: async (id) => {
    log("list", id);
    if (state !== "models" && state !== "cloudsaved")
      throw new Error("no listing");
    await new Promise((r) => setTimeout(r, 300));
    return id === "openai"
      ? ["text-embedding-3-small", "gpt-4.1", "gpt-4.1-mini", "gpt-4o"]
      : ["claude-sonnet-9", "claude-haiku-9"];
  },
  testCleanup: async (c) => {
    log("test", JSON.stringify(c));
    if (state === "s1-testing") return never;
    // "coldstart": the first Voce cleanup test starts the server (2.5 s).
    if (state === "coldstart" && c.kind === "s1") {
      await new Promise((r) => setTimeout(r, 2500));
      return { ok: true, ms: 250, startMs: 2200, output: CLEAN };
    }
    // "slow": Voce cleanup answers after 1.5 s, so a switch can outrun it.
    if (state === "slow" && c.kind === "s1") {
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true, ms: 1500, startMs: 0, output: "late" };
    }
    if (c.kind === "local")
      return state === "local-unreachable"
        ? { ok: false, error: "unreachable" }
        : { ok: true, ms: 900, startMs: 0, output: CLEAN };
    if (c.kind === "cloud")
      return state === "cloudsaved"
        ? { ok: true, ms: 700, startMs: 0, output: CLEAN }
        : { ok: false, error: "key_rejected" };
    // "keepfillers": s1-mini keeps "so" and "like", as the real one does.
    if (state === "keepfillers")
      return {
        ok: true,
        ms: 400,
        startMs: 0,
        output:
          "So I think we should move the standup to Thursday, like at 10.",
      };
    return { ok: true, ms: 400, startMs: 0, output: CLEAN };
  },
  saveCleanupChoice: async (c, id) => log("save", c.kind, id),
  setEarlyCleanup: async (on) => log("early", on),
  warmS1: async () => log("warm"),
  getEarlyCleanup: async () => ({
    enabled: true,
    available: state !== "cloudsaved",
    effective: state !== "off" && state !== "cloudsaved",
  }),
  setS1Control: async (c) => log("s1", c.styling, c.structure, c.context),
  // Failures come from the IPC stand-in's registration model (setup.ts).
  startTry: async () => {
    log("start");
    return {
      failedShortcuts: (
        window as unknown as {
          __failures: () => { id: string; binding: string; error: string }[];
        }
      ).__failures(),
    };
  },
  stopTry: async () => log("stop"),
  onTryEvent: async (cb) => {
    tryCb = cb;
    return () => {};
  },
  appleState: async () => "unsupported",
  getNamesEnabled: async () => true,
  setNamesEnabled: noop,
  getStorage: async () => ({
    voceBytes: 1848.4e6,
    diskTotal: 494.4e9,
    diskFree: 312.6e9,
    items: [
      [
        "speech:p",
        "speech_model",
        697e6,
        false,
        "Parakeet Unified EN 0.6B",
        true,
      ],
      ["meeting_model", "meeting_model", 617e6, true],
      ["cleanup_model", "cleanup_model", 480e6, true, "s1-mini"],
      ["runtime", "runtime", 30e6, false],
      ["recordings", "recordings", 18e6, true],
      ["call_data", "call_data", 6e6, false, "", false, 2],
      ["history", "history", 0.4e6, true, "", false, 41],
    ].map(
      ([
        id,
        kind,
        bytes,
        removable,
        name = "",
        inUse = false,
        count = null,
      ]) => ({
        id,
        kind,
        // "empty": nothing saved yet in recordings and history, as the app
        // reports it: an empty history database and a recordings folder
        // holding only .DS_Store still have a size.
        bytes:
          state === "empty" && kind === "recordings"
            ? 6148
            : state === "empty" && kind === "history"
              ? 24576
              : bytes,
        removable,
        name,
        inUse,
        count:
          kind === "recordings"
            ? state === "empty"
              ? 0
              : 3
            : state === "empty" && kind === "history"
              ? 0
              : count,
        retention: kind === "recordings" ? "days3" : undefined,
      }),
    ) as StorageItem[],
  }),
  removeStorageItem: noop,
  revealDataFolder: noop,
};
setFakeApi(fake);

const downloading =
  (step === "speech" || step === "try") && state === "downloading";
useModelStore.setState({
  models: state === "manycached" ? CACHED_MODELS : FAKE_MODELS,
  loading: false,
  // Settings pages run the store's real event listeners.
  initialized: (step as string) !== "cleanup-settings",
  downloadingModels: downloading ? { "p-unified": true } : {},
  downloadProgress: downloading
    ? {
        "p-unified": {
          model_id: "p-unified",
          downloaded: 248e6,
          total: 697e6,
          percentage: 35.6,
        },
      }
    : {},
  downloadStats: downloading
    ? {
        "p-unified": {
          startTime: 0,
          lastUpdate: Date.now(),
          totalDownloaded: 248e6,
          speed: 21.4,
        },
      }
    : {},
});

const nothing = () => {};
let view: React.ReactNode;
const settingsPage = (
  section: "storage" | "cleanup",
  page: React.ReactNode,
) => (
  <div className="h-screen flex select-none cursor-default bg-background">
    <Sidebar activeSection={section} onSectionChange={nothing} />
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="h-10 shrink-0" />
      <main className="flex-1 min-h-0 overflow-y-auto v-fade">
        <div className="v-col min-h-full">{page}</div>
      </main>
    </div>
  </div>
);
if ((step as string) === "cleanup-settings")
  useModelStore.getState().initialize();
// "stale": the page opens after the settings store has loaded old values.
const Later: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [shown, setShown] = React.useState(state !== "stale");
  React.useEffect(() => {
    const id = setTimeout(() => setShown(true), 1200);
    return () => clearTimeout(id);
  }, []);
  return shown ? <>{children}</> : null;
};
if ((step as string) === "cleanup-settings")
  view = settingsPage(
    "cleanup",
    <Later>
      <CleanupSettings />
    </Later>,
  );
else if (step === "storage" && state.startsWith("settings"))
  view = (
    <div className="h-screen flex select-none cursor-default bg-background">
      <Sidebar activeSection="storage" onSectionChange={nothing} />
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-10 shrink-0" />
        <main className="flex-1 min-h-0 overflow-y-auto v-fade">
          <div className="v-col min-h-full">
            <StorageSettings onOpenCalls={nothing} />
          </div>
        </main>
      </div>
    </div>
  );
else if (step === "names" && q.get("t"))
  view = (
    <Names
      step={5}
      onNext={nothing}
      onBack={nothing}
      freezeAt={Number(q.get("t"))}
    />
  );
else view = <Onboarding start={step} onDone={nothing} />;

ReactDOM.createRoot(document.getElementById("root")!).render(view);
