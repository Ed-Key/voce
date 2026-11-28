import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/** Whether the main window is on screen. The native close button only
 *  hides it (pages stay mounted), so pages pause timers and background work
 *  while this is false. Hidden: the page is hidden, or Voce reported the
 *  close; shown again: the page is visible or the window gets focus. */
export function useWindowVisible() {
  const [visible, setVisible] = useState(
    () => document.visibilityState === "visible",
  );
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    const shown = () => setVisible(true);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", shown);
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen("main-window-hidden", () => setVisible(false))
      .then((off) => (alive ? (unlisten = off) : off()))
      .catch((e) => console.warn("Window visibility:", e));
    return () => {
      alive = false;
      unlisten?.();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", shown);
    };
  }, []);
  return visible;
}
