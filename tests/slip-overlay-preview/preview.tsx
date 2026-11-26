// Renders the production overlay driven by a scripted run on a virtual clock.
// No app, no microphone: Tauri IPC and events are mocked, mic levels come from
// the playground's simulated voice.
//
// URL hash: t (playground ms), tl (main | cancel | empty | error), bg (dark |
// light), pos (bottom | top), lang (en, ar for RTL), outline (show the window box).
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { buildRun } from "./script";

const h = new URLSearchParams(location.hash.slice(1));
const bg = h.get("bg") ?? "dark";
const tl = h.get("tl") ?? "main";
const pos = h.get("pos") ?? "bottom";
const lang = h.get("lang") ?? "en";
const run = buildRun(tl);
const target = run.toHarness(Number(h.get("t") ?? 0));

// Virtual clock: the component reads performance.now and requestAnimationFrame.
let vt = 0;
performance.now = () => vt;
const rafs = new Map<number, FrameRequestCallback>();
let rafId = 0;
window.requestAnimationFrame = (cb) => {
  rafs.set(++rafId, cb);
  return rafId;
};
window.cancelAnimationFrame = (id) => {
  rafs.delete(id);
};

mockIPC(
  (cmd) => {
    if (cmd === "get_app_settings") {
      return { app_language: lang, overlay_position: pos, theme: bg };
    }
    return null;
  },
  { shouldMockEvents: true },
);

document.documentElement.dataset.theme = bg;
const strip = document.getElementById("strip")!;
strip.className = `strip ${bg}`;
const win = document.getElementById("window")!;
win.style.width = run.compact ? "320px" : "480px";
win.style.height = run.compact ? "90px" : "110px";
if (pos === "top") win.classList.add("top");
if (h.has("outline")) win.classList.add("outline");
const DOCK = [
  "#3478f6",
  "#f5f5f7",
  "#34c759",
  "#ff9f0a",
  "#ff453a",
  "#5e5ce6",
  "#e9e9eb",
  "#1c1c1e",
  "#30b0c7",
  "#ff375f",
  "#ffd60a",
  "#8e8e93",
  "#2f2b8c",
  "#64d2ff",
  "#ac8e68",
  "#bf5af2",
];
document.getElementById("dock")!.innerHTML = DOCK.map(
  (c) =>
    `<i style="background:linear-gradient(160deg,${c},color-mix(in srgb,${c} 70%,#000))"></i>`,
).join("");

const React = await import("react");
const { createRoot } = await import("react-dom/client");
await import("@/i18n");
const { default: RecordingOverlay } = await import(
  "../../src/overlay/RecordingOverlay"
);

createRoot(document.getElementById("root")!).render(
  React.createElement(RecordingOverlay),
);
await document.fonts.load("450 15px Figtree");
await document.fonts.load("500 13px Figtree");

const macrotask = () => new Promise((r) => setTimeout(r, 0));
// Let the listeners register.
for (let i = 0; i < 20; i++) await macrotask();

const bucket = (env: number) =>
  Math.pow(Math.min(0.77, 0.45 + 0.3 * env) * 1.3, 0.7);
const steps = [...run.steps];
let nextMic = 0;
for (let t = 0; ; t = Math.min(target, t + 16)) {
  // Deliver every event due by t at its own time.
  while (steps.length && steps[0].at <= t) {
    const step = steps.shift()!;
    vt = step.at;
    await emit(step.event, "payload" in step ? step.payload : null);
    await macrotask();
    await macrotask();
  }
  while (nextMic <= t && nextMic <= run.micUntil) {
    vt = nextMic;
    await emit("mic-level", Array(16).fill(bucket(run.envAt(nextMic))));
    nextMic += 33;
  }
  vt = t;
  const due = [...rafs.values()];
  rafs.clear();
  due.forEach((cb) => cb(vt));
  await macrotask();
  if (t >= target) break;
}
document.title = "ready";
