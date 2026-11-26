// The whole main window with mocked commands and invented data, so the
// redesign can be checked without the app, a microphone or real settings.
// Query: ?section=history&theme=light&scroll=bottom
import React from "react";
import ReactDOM from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fixture } from "./fixture";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") ?? "dark";

Object.assign(window, {
  __TAURI_OS_PLUGIN_INTERNALS__: {
    platform: "macos",
    os_type: "macos",
    family: "unix",
    arch: "aarch64",
    version: "26.0",
    eol: "\n",
    exe_extension: "",
  },
});

const state = fixture(theme);

// Automated headless Chrome cannot decode audio, so there the clips report their
// length directly; a headed browser loads the real WAV metadata.
if (navigator.webdriver) {
  const lengths = new Map(
    Object.values(state.audio).map((url, i) => [url, [38, 6, 21][i]]),
  );
  const media = HTMLMediaElement.prototype;
  Object.defineProperty(media, "readyState", {
    get(this: HTMLMediaElement) {
      return lengths.has(this.src) ? 1 : 0;
    },
  });
  Object.defineProperty(media, "duration", {
    get(this: HTMLMediaElement) {
      return lengths.get(this.src) ?? NaN;
    },
  });
}

mockIPC(
  async (command, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (command.startsWith("plugin:event|")) return 1;
    if (command.startsWith("plugin:macos-permissions|")) return true;
    if (command === "plugin:app|version") return "0.9.8";
    if (command === "get_audio_file_path") {
      const clip = state.audio[a.fileName as string];
      if (!clip) throw "This recording's audio is no longer kept";
      return clip;
    }
    if (command.startsWith("change_") || command.startsWith("set_"))
      return null;
    if (command in state.replies) return state.replies[command];
    return null;
  },
  { shouldMockEvents: true },
);
// Audio paths in the fixture are already playable blob URLs.
(
  window as unknown as {
    __TAURI_INTERNALS__: { convertFileSrc: (p: string) => string };
  }
).__TAURI_INTERNALS__.convertFileSrc = (path: string) => path;

try {
  localStorage.setItem("handy.theme", theme);
} catch {
  // The harness still renders with the system theme.
}

const [{ default: App }, { applyTheme }, { useModelStore }] = await Promise.all(
  [
    import("@/App"),
    import("@/lib/utils/theme"),
    import("@/stores/modelStore"),
    import("@/i18n"),
  ],
);
document.documentElement.dataset.platform = "macos";
applyTheme(theme as "dark" | "light" | "system");
useModelStore.getState().initialize();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Open the requested page and scroll it, then mark the page ready for screenshots.
const section = query.get("section");
const scroll = query.get("scroll");
const open = setInterval(() => {
  const nav = document.querySelector<HTMLElement>(
    `[data-section="${section ?? "general"}"]`,
  );
  if (!nav) return;
  clearInterval(open);
  nav.click();
  setTimeout(() => {
    const main = document.querySelector("main");
    if (main && scroll === "bottom") main.scrollTop = main.scrollHeight;
    document.body.dataset.ready = "1";
  }, 600);
}, 50);
