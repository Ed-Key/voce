import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./RecordingOverlay.css";
import { commands, events } from "@/bindings";
import type { StreamTextEvent } from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";
import {
  BADGE,
  type EndReason,
  type Frame,
  LINE,
  type OverlayEvent,
  type Session,
  SLIP,
  drawParts,
  fingerLevels,
  frameAt,
  messageCardWidth,
  newLevelInput,
  newReact,
  reactStep,
  readLevels,
  reduce,
} from "./slip";

const MESSAGE_KEY: Record<EndReason, string> = {
  cancelled: "overlay.cancelled",
  nothing_heard: "overlay.nothingHeard",
  error: "overlay.couldNotTranscribe",
};
const END_REASONS = Object.keys(MESSAGE_KEY);
const EMPTY_TEXT: StreamTextEvent = { committed: "", tentative: "" };

// The Slip overlay: the hand mark in a card that widens into a slip of live
// text. Motion comes from slip.ts as a pure function of the session and the
// clock; this component feeds it events and paints each frame straight onto
// the DOM, so a frame never waits on a React render.
const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  // Bumped on every new press. The frame loop restarts on it, so a press that
  // lands between the last frame's unmount and React's commit still runs.
  const [run, setRun] = useState(0);
  const [text, setText] = useState<StreamTextEvent>(EMPTY_TEXT);
  const [reason, setReason] = useState<EndReason | null>(null);
  const [position, setPosition] = useState<"top" | "bottom">("bottom");
  const direction = getLanguageDirection(i18n.language);

  const sessionRef = useRef<Session | null>(null);
  const levelsRef = useRef(newLevelInput());
  const reactRef = useRef(newReact());
  const lvRef = useRef([0, 0, 0, 0]);
  const lastTickRef = useRef(0);
  const positionRef = useRef(position);
  // Only the live ("streaming") overlay has room for text; Minimal mode keeps
  // the compact card even when the model streams.
  const liveRef = useRef(false);
  positionRef.current = position;

  const cardRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const lineRefs = useRef<(SVGLineElement | null)[]>([]);
  const badgeRef = useRef<SVGCircleElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const tentRef = useRef<HTMLSpanElement>(null);
  const msgRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const measureMsgRef = useRef<HTMLSpanElement>(null);

  const dispatchRef = useRef<(ev: OverlayEvent) => void>(() => {});
  dispatchRef.current = (ev: OverlayEvent) => {
    const prev = sessionRef.current;
    const next = reduce(prev, ev, performance.now(), {
      lv: lvRef.current,
      msgW: (r) => {
        const span = measureMsgRef.current;
        if (!span) return 0;
        span.textContent = t(MESSAGE_KEY[r]);
        return messageCardWidth(span.offsetWidth);
      },
    });
    if (next && next !== prev) {
      // A new press: fresh text, levels and message.
      reactRef.current = newReact();
      lvRef.current = [0, 0, 0, 0];
      setText(EMPTY_TEXT);
      setReason(null);
      setRun((n) => n + 1);
    }
    sessionRef.current = next;
    if (next) setMounted(true);
  };
  const dispatch = (ev: OverlayEvent) => dispatchRef.current(ev);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const keep = (unlisten: () => void) =>
      disposed ? unlisten() : unlisteners.push(unlisten);

    const setup = async () => {
      keep(
        await listen<string>("show-overlay", async (event) => {
          // Dispatch before any settings I/O: a fast microphone can report
          // ready while the awaits below are in flight.
          if (event.payload === "recording" || event.payload === "streaming")
            liveRef.current = event.payload === "streaming";
          dispatch({ type: "show", state: event.payload });
          await syncLanguageFromSettings();
          try {
            const settings = await commands.getAppSettings();
            if (settings.status === "ok") {
              setPosition(
                settings.data.overlay_position === "top" ? "top" : "bottom",
              );
            }
          } catch {
            // Keep the previous placement if settings can't be read.
          }
        }),
      );
      keep(await listen("hide-overlay", () => dispatch({ type: "hide" })));
      keep(await listen("recording-ready", () => dispatch({ type: "ready" })));
      keep(
        await listen<string>("overlay-ended", (event) => {
          if (!END_REASONS.includes(event.payload)) return;
          const r = event.payload as EndReason;
          const s = sessionRef.current;
          if (s && s.end === null && s.tExit === null) setReason(r);
          dispatch({ type: "ended", reason: r });
        }),
      );
      keep(
        await listen<number[]>("mic-level", (event) =>
          readLevels(levelsRef.current, event.payload, performance.now()),
        ),
      );
      keep(
        await events.streamTextEvent.listen((event) => {
          const s = sessionRef.current;
          if (!liveRef.current) return;
          if (!s || s.end !== null || s.tExit !== null) return;
          dispatch({ type: "text", ...event.payload });
          setText(event.payload);
        }),
      );
      keep(
        await events.streamPhaseEvent.listen((event) => {
          if (event.payload.phase === "working") {
            dispatch({
              type: "phase",
              kind: event.payload.kind ?? "transcribing",
            });
          }
        }),
      );
    };
    setup();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  // Count rendered lines so a new line can turn in. Measured off-screen at the
  // full slip width, since the visible text may still be hidden or widening.
  useLayoutEffect(() => {
    const measure = () => {
      const el = measureRef.current;
      if (!el || !sessionRef.current) return;
      if (!text.committed && !text.tentative) return;
      dispatch({ type: "lines", n: Math.round(el.offsetHeight / LINE) });
    };
    measure();
    document.fonts?.ready.then(measure);
  }, [text]);

  // Frame loop while mounted.
  useLayoutEffect(() => {
    if (!mounted) return;
    let raf = 0;
    lastTickRef.current = performance.now();
    const tick = () => {
      const s = sessionRef.current;
      const now = performance.now();
      const dt = Math.min(100, Math.max(0, now - lastTickRef.current));
      lastTickRef.current = now;
      if (!s) {
        setMounted(false);
        return;
      }
      // The fingers follow the voice until release, then hold still.
      if (s.tRelease === null && s.end === null && s.tExit === null) {
        reactStep(reactRef.current, dt, now, levelsRef.current);
        lvRef.current = fingerLevels(reactRef.current.lev, now);
      }
      const frame = frameAt(s, now, lvRef.current);
      paint(frame);
      if (frame.done) {
        sessionRef.current = null;
        setMounted(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [mounted, run]);

  function paint(f: Frame) {
    const card = cardRef.current;
    const group = groupRef.current;
    if (!card || !group) return;
    const c = f.card;
    const dy = positionRef.current === "top" ? -c.dy : c.dy;
    card.style.width = `${c.w.toFixed(1)}px`;
    card.style.height = `${c.h.toFixed(1)}px`;
    card.style.borderRadius = `${c.r.toFixed(1)}px`;
    card.style.paddingInlineEnd = `${c.pr.toFixed(1)}px`;
    card.style.opacity = c.op.toFixed(3);
    card.style.transform = `translateY(${dy.toFixed(2)}px)`;

    const clip = clipRef.current;
    const flow = flowRef.current;
    if (clip && flow) {
      if (f.text) {
        clip.style.display = "block";
        clip.style.height = `${(LINE * f.text.clip).toFixed(1)}px`;
        clip.style.opacity = f.text.op.toFixed(3);
        flow.style.transform = `translateY(${f.text.shift.toFixed(2)}px)`;
        flow.style.setProperty("--slip-dim", f.text.dim.toFixed(3));
        tentRef.current?.classList.toggle("settled", !f.text.tentative);
      } else {
        clip.style.display = "none";
      }
    }
    const msg = msgRef.current;
    if (msg) {
      msg.style.display = f.msg ? "block" : "none";
      if (f.msg) {
        msg.style.opacity = f.msg.op.toFixed(3);
        msg.classList.toggle("err", f.msg.reason === "error");
      }
    }

    // One group carries the whole-mark fade, so overlapping parts (thumb
    // behind palm) never show a brighter overlap.
    group.setAttribute("opacity", f.mark.op.toFixed(3));
    drawParts(f.mark).forEach((p, j) => {
      const l = lineRefs.current[j];
      if (!l) return;
      l.setAttribute("x1", p.x1.toFixed(1));
      l.setAttribute("y1", p.y1.toFixed(1));
      l.setAttribute("x2", p.x2.toFixed(1));
      l.setAttribute("y2", p.y2.toFixed(1));
      l.setAttribute("stroke-width", p.width.toFixed(2));
      l.setAttribute("opacity", p.op.toFixed(3));
      l.style.stroke =
        p.amber > 0
          ? `color-mix(in srgb, var(--slip-amber) ${(p.amber * 100).toFixed(1)}%, var(--slip-ink))`
          : "var(--slip-ink)";
    });
    const badge = badgeRef.current;
    if (badge) {
      const b = Math.max(0, Math.min(1, f.mark.badge));
      badge.setAttribute("r", (BADGE.r * b).toFixed(1));
      badge.setAttribute("opacity", f.mark.badge > 0 ? "1" : "0");
    }
  }

  return (
    <div dir={direction} className={`ov-stage ${position}`}>
      {mounted && (
        <div className="slip" ref={cardRef}>
          <svg
            viewBox="205 215 610 610"
            width={SLIP.glyph}
            height={SLIP.glyph}
            aria-hidden="true"
          >
            <g ref={groupRef}>
              {[0, 1, 2, 3, 4, 5].map((j) => (
                <line
                  key={j}
                  ref={(el) => {
                    lineRefs.current[j] = el;
                  }}
                  strokeLinecap="round"
                />
              ))}
            </g>
            <circle
              ref={badgeRef}
              className="slip-badge"
              cx={BADGE.cx}
              cy={BADGE.cy}
              r={0}
              opacity={0}
            />
          </svg>
          <div className="slip-clip" ref={clipRef}>
            <div className="slip-flow" ref={flowRef}>
              <span className="c">{text.committed}</span>{" "}
              <span className="t" ref={tentRef}>
                {text.tentative}
              </span>
            </div>
          </div>
          <span className="slip-msg" ref={msgRef}>
            {reason ? t(MESSAGE_KEY[reason]) : ""}
          </span>
        </div>
      )}
      <div className="slip-measure" ref={measureRef} aria-hidden="true">
        <span>{text.committed}</span> <span>{text.tentative}</span>
      </div>
      <span
        className="slip-measure-msg"
        ref={measureMsgRef}
        aria-hidden="true"
      />
    </div>
  );
};

export default RecordingOverlay;
