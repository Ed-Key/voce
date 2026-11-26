// Scripted dictation runs that replay the motion playground's timelines as
// overlay events, so the real component can be captured at the same moments.
// The word schedule and voice envelope are the playground's, with its approved
// settings (165 wpm, 600 ms commit lag). Fictional text only.

const TEXT =
  "Okay, so for the meeting tomorrow, the main thing I want to cover is that the new build now starts in two seconds instead of seven. Everything else looks the same, so I think we can ship it to everyone on Friday.";

interface Word {
  w: string;
  t0: number;
  t1: number;
  ta: number;
  tc: number;
  syl: number;
  loud: number;
}

function hash(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export const WORDS: Word[] = (() => {
  const per = 60000 / 165;
  let t = 250;
  const W = TEXT.split(" ").map((w, i) => {
    const len = w.replace(/[,.]/g, "").length;
    const d = per * (0.45 + (0.55 * len) / 4.5) * 0.85;
    const o = {
      w,
      t0: t,
      t1: t + d,
      ta: 0,
      tc: 0,
      syl: Math.max(1, Math.round(len / 3)),
      loud: 0.7 + 0.3 * hash(i * 7.3),
    };
    t += d + per * 0.15 + (/,$/.test(w) ? 260 : /\.$/.test(w) ? 750 : 0);
    return o;
  });
  let pc = 0;
  W.forEach((w, i) => {
    w.ta = w.t1 + 120;
    w.tc = pc = Math.max(
      pc + 45,
      w.ta + 10,
      w.t1 + 600 + (hash(i * 3.1) - 0.5) * 220,
    );
  });
  return W;
})();
const SEND = WORDS[WORDS.length - 1].t1;

/** Voice envelope 0..1 at tau ms after the first word is due. */
export function voice(tau: number) {
  const w = WORDS.find((x) => tau >= x.t0 && tau <= x.t1);
  if (!w) return 0;
  const ph = (tau - w.t0) / (w.t1 - w.t0);
  return (
    w.loud *
    Math.sqrt(Math.sin(Math.PI * ph)) *
    (0.55 + 0.45 * Math.abs(Math.sin(Math.PI * w.syl * ph)))
  );
}

export type Step =
  | { at: number; event: "show-overlay"; payload: string }
  | { at: number; event: "recording-ready" }
  | {
      at: number;
      event: "stream-text-event";
      payload: { committed: string; tentative: string };
    }
  | {
      at: number;
      event: "stream-phase-event";
      payload: { phase: "working"; kind: string };
    }
  | { at: number; event: "hide-overlay" }
  | { at: number; event: "overlay-ended"; payload: string };

export interface Run {
  steps: Step[];
  /** Voice envelope at harness time t (mic levels are fed while it is defined). */
  envAt: (t: number) => number;
  micUntil: number;
  /** Harness time for a playground time on the same timeline. */
  toHarness: (t: number) => number;
  compact: boolean;
}

// Playground main timeline (approved settings): arming 700 ms, morph 520 ms.
const T1 = 700;
const TW = T1 + 520 * 0.5;
const TR = TW + SEND + 350;
const TP = TR + 515 + 500;
const TX = TP + 900;

function textSteps(until: number): Step[] {
  const times = [...new Set(WORDS.flatMap((w) => [w.ta, w.tc]))].sort(
    (a, b) => a - b,
  );
  const steps: Step[] = [];
  for (const tau of times) {
    if (TW + tau > until) break;
    const shown = WORDS.filter((w) => w.ta <= tau);
    const committed = shown.filter((w) => w.tc <= tau).map((w) => w.w);
    const tentative = shown.filter((w) => w.tc > tau).map((w) => w.w);
    steps.push({
      at: TW + tau,
      event: "stream-text-event",
      payload: {
        committed: committed.join(" "),
        tentative: tentative.join(" "),
      },
    });
  }
  return steps;
}

export function buildRun(tl: string): Run {
  const env = (t: number) => voice(t - TW);
  if (tl === "cancel") {
    // The playground's cancel run opens on a listening slip with 24 words and
    // cancels at 900 ms. Replay a real session up to that point instead.
    const tc = TW + WORDS[23].ta + 1;
    return {
      steps: [
        { at: 0, event: "show-overlay", payload: "streaming" },
        { at: T1, event: "recording-ready" },
        ...textSteps(tc),
        { at: tc, event: "overlay-ended", payload: "cancelled" },
      ],
      envAt: env,
      micUntil: tc,
      toHarness: (t) => tc + t - 900,
      compact: false,
    };
  }
  if (tl === "empty" || tl === "error") {
    // Released with no audio heard: dots circle, then land at 700 ms.
    return {
      steps: [
        { at: 0, event: "show-overlay", payload: "recording" },
        { at: 1, event: "show-overlay", payload: "transcribing" },
        {
          at: 700,
          event: "overlay-ended",
          payload: tl === "empty" ? "nothing_heard" : "error",
        },
      ],
      envAt: () => 0,
      micUntil: 0,
      toHarness: (t) => t,
      compact: true,
    };
  }
  return {
    steps: [
      { at: 0, event: "show-overlay", payload: "streaming" },
      { at: T1, event: "recording-ready" },
      ...textSteps(TR),
      {
        at: TR,
        event: "stream-phase-event",
        payload: { phase: "working", kind: "transcribing" },
      },
      {
        at: TP,
        event: "stream-phase-event",
        payload: { phase: "working", kind: "polishing" },
      },
      { at: TX, event: "hide-overlay" },
    ],
    envAt: env,
    micUntil: TR,
    toHarness: (t) => t,
    compact: false,
  };
}

/** Playground times of the commits, for capturing a nod. */
export const COMMIT_TIMES = WORDS.map((w) => TW + w.tc);
