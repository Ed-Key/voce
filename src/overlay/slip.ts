// Slip overlay motion: geometry, timing and lifecycle, with the tuned
// settings fixed in: 5 dots, outCubic
// ease, swirl travel, thumb never amber, amber on the head dot while polishing,
// speech-gated loudness with a ripple nod per committed word.
//
// Everything here is a pure function of the session and the clock, so the
// lifecycle (docs/overlay-lifecycle.md) is testable without a webview.

export const SLIP = {
  dots: 5,
  radius: 6.5,
  dotSize: 2.9,
  spin: 1.1,
  tail: 0.55,
  morphMs: 520,
  stagger: 45,
  landMs: 250,
  settleMs: 380,
  attack: 45,
  release: 220,
  gain: 1.3,
  maxLen: 1,
  restLen: 0.28,
  spread: 0.5,
  polishDim: 0.62,
  enterMs: 140,
  exitMs: 160,
  rise: 6,
  widenMs: 240,
  turnMs: 220,
  holdMs: 900,
  glyph: 22,
  gateTh: 0.12,
  gateHold: 250,
  nodSize: 0.5,
  nodMs: 130,
} as const;

export const SLIP_W = 420;
export const LINE = 22;
export const PILL_W = SLIP.glyph + 26;
/** Text column width inside the full slip: card minus border, paddings, gap, mark. */
export const TEXT_W = SLIP_W - 2 - 12 - 16 - 11 - SLIP.glyph;
/** Card width that fits an end message of the given text width. */
export const messageCardWidth = (textWidth: number) =>
  Math.ceil(textWidth) + SLIP.glyph + 12 + 9 + 17 + 2;
export const cardHeight = (clipPx: number) => Math.max(clipPx, SLIP.glyph) + 24;

const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const outCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const inOutCubic = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const outBack = (x: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

/* ---------- mark geometry (Voce icon coordinates, viewBox 205 215 610 610) ---------- */

type Pt = [number, number];
interface Part {
  b: Pt;
  tip?: Pt;
  tA?: Pt;
  tB?: Pt;
  w: number;
}
const C: Pt = [510, 520];
// Paint order of the app icon: thumb, four fingers, palm last (the thumb tucks
// behind the palm). Also clockwise from the left, the order the dots match.
export const PARTS: Part[] = [
  { b: [438.55, 715.73], tip: [281.47, 621.35], w: 78.94 },
  { b: [410.74, 550.91], tip: [363.01, 412.3], w: 78.94 },
  { b: [515.21, 538.09], tip: [467.51, 292.7], w: 78.94 },
  { b: [619.68, 525.26], tip: [609.06, 322.54], w: 78.94 },
  { b: [724.15, 512.43], tip: [733.65, 403.83], w: 78.94 },
  {
    b: [585.55, 679.05],
    tA: [466.15, 693.71],
    tB: [704.94, 664.39],
    w: 154.12,
  },
];
const PRIO = [1, 2, 3, 4, 0, 5]; // which parts get a dot first
const UNIT = 610 / SLIP.glyph; // icon units per CSS pixel
export const BADGE = { cx: 712, cy: 330, r: 92 };

/** Position of loader dot `s` at `t` ms after the session started. */
export function circ(s: number, t: number): Pt {
  const R = SLIP.radius * UNIT;
  const an = 6.2831853 * ((SLIP.spin * t) / 1000 + s / SLIP.dots) - 1.5708;
  return [C[0] + R * Math.cos(an), C[1] + R * Math.sin(an)];
}

/** Which dot travels to which part: the rotation with the shortest total trip. */
export function assign(tRef: number): number[] {
  const N = SLIP.dots;
  const A = Math.min(N, 6);
  const set = PRIO.slice(0, A).sort((a, b) => a - b);
  let best: { d: number; m: number[] } | null = null;
  for (let sh = 0; sh < N; sh++) {
    let d = 0;
    const m = [-1, -1, -1, -1, -1, -1];
    set.forEach((pi, k) => {
      const s = (sh + Math.round((k * N) / A)) % N;
      m[pi] = s;
      const q = circ(s, tRef);
      d += Math.hypot(q[0] - PARTS[pi].b[0], q[1] - PARTS[pi].b[1]);
    });
    if (!best || d < best.d) best = { d, m };
  }
  return best!.m;
}

/** Per part: a = travel from dot to finger foot, e = finger drawn up. */
export function morph(clock: number, dur: number) {
  const a: number[] = [];
  const e: number[] = [];
  for (let j = 0; j < 6; j++) {
    const o = j >= 1 && j <= 4 ? j - 1 : 0;
    const c = clock - o * SLIP.stagger;
    a[j] = outCubic(cl(c / (dur * 0.6)));
    e[j] = outCubic(cl((c - dur * 0.4) / (dur * 0.6)));
  }
  return { a, e };
}
export const morphTotal = (dur: number) => dur + 3 * SLIP.stagger;
const MORPH_TOTAL = morphTotal(SLIP.morphMs);
const SETTLE_TOTAL = morphTotal(SLIP.settleMs);

/* ---------- levels: speech-gated loudness ---------- */

function hash(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function noise(i: number, x: number) {
  const f = Math.floor(x);
  const u = x - f;
  const s = u * u * (3 - 2 * u);
  return lerp(hash(f + i * 57.3), hash(f + 1 + i * 57.3), s);
}
const PROF = [0.8, 1, 0.9, 0.68];

// ponytail: calibration knob, set from the visualizer's own notes (room tone
// about -48, dictation about -32 in its dB scale) and not yet checked against
// a real microphone. Raise it if the fingers sit too high, lower it if speech
// barely lifts them.
const SPEECH_SPAN = 0.3;

export interface LevelInput {
  floor: number | null;
  at: number;
  loud: number;
  vad: number;
}
export const newLevelInput = (): LevelInput => ({
  floor: null,
  at: 0,
  loud: 0,
  vad: 0,
});

/**
 * Reads one `mic-level` frame (16 FFT buckets, 400 to 4000 Hz, each already
 * shaped as (x * 1.3) ^ 0.7 by the visualizer) into a loudness above a learned
 * noise floor. The floor falls fast and rises slowly, so room tone, fans and
 * steady hum read as silence.
 */
export function readLevels(inp: LevelInput, buckets: number[], now: number) {
  if (!buckets.length) return;
  let sum = 0;
  for (const b of buckets) sum += cl(Math.pow(Math.max(0, b), 1 / 0.7) / 1.3);
  const raw = sum / buckets.length;
  const dt = Math.max(0, now - inp.at);
  inp.at = now;
  inp.floor =
    inp.floor === null
      ? raw
      : inp.floor +
        (raw - inp.floor) *
          (1 - Math.exp(-dt / (raw < inp.floor ? 150 : 5300)));
  inp.loud = cl((raw - inp.floor) / SPEECH_SPAN);
  inp.vad = inp.loud;
}

export interface ReactState {
  L: number;
  pk: number;
  g: number;
  last: number;
  lev: number;
}
export const newReact = (): ReactState => ({
  L: 0,
  pk: 0.45,
  g: 0,
  last: -1e9,
  lev: 0,
});

/** One step of the speech-gated level: follow loudness, auto-level, gate. */
export function reactStep(
  c: ReactState,
  dt: number,
  now: number,
  inp: LevelInput,
) {
  c.L +=
    (inp.loud - c.L) *
    (1 - Math.exp(-dt / (inp.loud > c.L ? SLIP.attack : SLIP.release)));
  c.pk = Math.max(c.L, c.pk * Math.exp(-dt / 4000), 0.45);
  const lev = cl(((SLIP.gain / 1.3) * 0.85 * c.L) / c.pk);
  if (inp.vad > SLIP.gateTh) c.last = now;
  const open = now - c.last < SLIP.gateHold ? 1 : 0;
  c.g += (open - c.g) * (1 - Math.exp(-dt / (open ? 35 : 140)));
  c.lev = lev * c.g;
}

/** The four finger levels (0..1) for a gated level. */
export const fingerLevels = (lev: number, now: number) =>
  PROF.map((p, i) =>
    cl(lev * (p + SLIP.spread * 0.5 * (noise(i, now / 260) - 0.5))),
  );

const kOf = (v: number) => SLIP.restLen + (SLIP.maxLen - SLIP.restLen) * v;

/** Nod shape ("snap"): quick down, soft return. */
export function nodPulse(x: number) {
  if (x <= 0 || x >= 1) return 0;
  return x < 0.3 ? outCubic(x / 0.3) : 1 - inOutCubic((x - 0.3) / 0.7);
}

/* ---------- session ---------- */

export type EndReason = "cancelled" | "nothing_heard" | "error";
export type Phase =
  | "arming"
  | "morph"
  | "listening"
  | "release"
  | "finishing"
  | "polishing"
  | "exiting"
  | "ended";

interface Box {
  w: number;
  h: number;
  r: number;
  pr: number;
}
export interface TextFrame {
  op: number;
  dim: number;
  clip: number; // visible lines
  shift: number; // px the flow sits below its resting place
  tentative: boolean; // still show tentative words dim
}
interface End {
  t: number;
  reason: EndReason;
  hand: boolean;
  clock0: number;
  asg: number[];
  k0: number[];
  box: Box;
  text: TextFrame | null;
  msgW: number;
}
export interface Session {
  t0: number;
  tAudio: number | null;
  tRelease: number | null;
  relFrom: number; // settle clock the release starts from (a partial hand releases from part way)
  tPolish: number | null;
  tText: number | null;
  tExit: number | null;
  words: number;
  commits: number[];
  lines: number;
  turn: { t: number; shift0: number; from: number; to: number } | null;
  end: End | null;
}
export interface Mark {
  tSrc: number;
  asg: number[];
  a: number[];
  e: number[];
  k: number[];
  rip: number[];
  op: number;
  headAmber: number;
  badge: number;
}
export interface Frame {
  phase: Phase;
  done: boolean;
  mark: Mark;
  card: Box & { op: number; dy: number };
  text: TextFrame | null;
  msg: { op: number; reason: EndReason } | null;
}

export type OverlayEvent =
  | { type: "show"; state: string }
  | { type: "ready" }
  | { type: "text"; committed: string; tentative: string }
  | { type: "phase"; kind: "transcribing" | "polishing" }
  | { type: "lines"; n: number }
  | { type: "hide" }
  | { type: "ended"; reason: EndReason };

export interface Context {
  lv: number[]; // current finger levels 0..1
  msgW: (reason: EndReason) => number;
}

const newSession = (now: number): Session => ({
  t0: now,
  tAudio: null,
  tRelease: null,
  relFrom: 0,
  tPolish: null,
  tText: null,
  tExit: null,
  words: 0,
  commits: [],
  lines: 1,
  turn: null,
  end: null,
});

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const settled = (s: Session) => s.end !== null || s.tExit !== null;

function release(s: Session, now: number) {
  if (s.tRelease !== null || settled(s)) return;
  s.tRelease = now;
  if (s.tAudio !== null) {
    const c = Math.min(Math.max(0, now - s.tAudio), MORPH_TOTAL);
    s.relFrom = (c / MORPH_TOTAL) * SETTLE_TOTAL;
  }
}

function visibleLines(s: Session, now: number) {
  if (!s.turn) return { clip: Math.min(2, Math.max(1, s.lines)), shift: 0 };
  const p = outCubic(cl((now - s.turn.t) / SLIP.turnMs));
  return {
    clip: lerp(s.turn.from, s.turn.to, p),
    shift: s.turn.shift0 * (1 - p),
  };
}

/**
 * Applies one overlay event. Returns the session to keep: a new object for a
 * new press, the same (mutated) one otherwise, or null when nothing is shown.
 */
export function reduce(
  s: Session | null,
  ev: OverlayEvent,
  now: number,
  ctx: Context,
): Session | null {
  if (ev.type === "show") {
    if (ev.state === "recording" || ev.state === "streaming")
      return newSession(now);
    // The compact overlay reports release and polish as show states.
    const cur = s && !settled(s) ? s : newSession(now);
    release(cur, now);
    if (ev.state === "processing" && cur.tPolish === null) cur.tPolish = now;
    return cur;
  }
  if (!s) return null;
  switch (ev.type) {
    case "ready":
      if (s.tAudio === null && s.tRelease === null && !settled(s))
        s.tAudio = now;
      break;
    case "phase":
      release(s, now);
      if (ev.kind === "polishing" && s.tPolish === null && !settled(s))
        s.tPolish = now;
      break;
    case "text": {
      if (settled(s)) break;
      if (s.tText === null && (ev.committed || ev.tentative)) s.tText = now;
      const words = countWords(ev.committed);
      if (words > s.words) {
        s.commits = s.commits.filter((c) => now - c < SLIP.nodMs + 200);
        s.commits.push(now);
      }
      s.words = words;
      break;
    }
    case "lines": {
      if (settled(s)) break;
      const n = Math.max(1, ev.n);
      if (n > s.lines) {
        // A new line turns in from below; only growth animates.
        const cur = visibleLines(s, now);
        s.turn = {
          t: now,
          shift0: cur.shift + LINE * (n - s.lines),
          from: cur.clip,
          to: Math.min(2, n),
        };
      } else if (n < s.lines) {
        s.turn = null; // a rewrite shortened the text: snap, no animation
      }
      s.lines = n;
      break;
    }
    case "hide":
      if (s.tExit === null) s.tExit = now;
      break;
    case "ended": {
      if (settled(s)) break;
      const f = frameAt(s, now, ctx.lv);
      const hand =
        s.tAudio !== null &&
        s.tRelease === null &&
        now - s.tAudio >= MORPH_TOTAL;
      let clock0 = 0;
      if (s.tAudio !== null) {
        clock0 =
          s.tRelease === null
            ? Math.min(now - s.tAudio, MORPH_TOTAL)
            : (Math.max(0, s.relFrom - (now - s.tRelease)) / SETTLE_TOTAL) *
              MORPH_TOTAL;
      }
      s.end = {
        t: now,
        reason: ev.reason,
        hand,
        clock0,
        asg: clock0 > 0 ? f.mark.asg : assign(now - s.t0 + SLIP.morphMs * 0.3),
        k0: f.mark.k,
        box: { w: f.card.w, h: f.card.h, r: f.card.r, pr: f.card.pr },
        text: f.text,
        msgW: ctx.msgW(ev.reason),
      };
      break;
    }
  }
  return s;
}

const ZERO6 = [0, 0, 0, 0, 0, 0];
const ONE6 = [1, 1, 1, 1, 1, 1];

/** Everything to draw at `now`. `lv` are the live finger levels (0..1). */
export function frameAt(s: Session, now: number, lv: number[]): Frame {
  const t = now - s.t0;
  const en = outCubic(cl(t / SLIP.enterMs));
  if (s.end) return endedFrame(s, s.end, now, en);

  const tA = s.tAudio === null ? null : s.tAudio - s.t0;
  const tR = s.tRelease === null ? Infinity : s.tRelease - s.t0;
  const mo =
    tA === null
      ? { a: ZERO6, e: ZERO6 }
      : t < tR
        ? morph(t - tA, SLIP.morphMs)
        : morph(s.relFrom - (t - tR), SLIP.settleMs);
  const asg =
    t < tR
      ? assign((tA ?? 0) + SLIP.morphMs * 0.3)
      : assign(tR + SETTLE_TOTAL - SLIP.settleMs * 0.3);
  // Lands on the exact logo, holds, then follows the voice.
  const land =
    tA === null
      ? 0
      : inOutCubic(cl((t - (tA + MORPH_TOTAL + SLIP.landMs)) / 260));
  const k = lv.map((v) => lerp(1, kOf(v), land));
  const hand = land * (1 - cl((t - tR) / 80)); // nods only while it is the hand
  const pulse = (at: number) => {
    let m = 0;
    for (const c of s.commits) {
      const v = nodPulse((at - c) / SLIP.nodMs);
      if (Math.abs(v) > Math.abs(m)) m = v;
    }
    return m;
  };
  const rip = [0, 1, 2, 3].map((i) =>
    hand > 0 ? hand * pulse(now - i * 38) * SLIP.nodSize * 0.36 : 0,
  );
  const pp = s.tPolish === null ? 0 : cl((now - s.tPolish) / 150);

  const ex = s.tExit === null ? 0 : outCubic(cl((now - s.tExit) / SLIP.exitMs));
  const wp =
    s.tText === null ? 0 : outCubic(cl((now - s.tText) / SLIP.widenMs));
  let text: TextFrame | null = null;
  let clipPx = LINE;
  if (s.tText !== null) {
    const vl = visibleLines(s, now);
    clipPx = LINE * vl.clip;
    text = {
      op: cl((now - s.tText - SLIP.widenMs * 0.4) / (SLIP.widenMs * 0.6)),
      dim: lerp(1, SLIP.polishDim, pp),
      clip: vl.clip,
      shift: vl.shift,
      tentative: t < tR + SETTLE_TOTAL,
    };
  }

  let phase: Phase;
  if (s.tExit !== null) phase = "exiting";
  else if (s.tPolish !== null) phase = "polishing";
  else if (s.tRelease !== null)
    phase = t < tR + SETTLE_TOTAL ? "release" : "finishing";
  else if (tA === null) phase = "arming";
  else phase = t < tA + MORPH_TOTAL ? "morph" : "listening";

  return {
    phase,
    done: s.tExit !== null && now >= s.tExit + SLIP.exitMs,
    mark: {
      tSrc: t,
      asg,
      a: mo.a,
      e: mo.e,
      k,
      rip,
      op: 1,
      headAmber: pp,
      badge: 0,
    },
    card: {
      op: en * (1 - ex),
      dy: SLIP.rise * (1 - en) + SLIP.rise * ex,
      w: lerp(PILL_W, SLIP_W, wp),
      h: cardHeight(clipPx),
      r: lerp(23, 16, wp),
      pr: lerp(12, 16, wp),
    },
    text,
    msg: null,
  };
}

/** Total time of an end sequence, from the end event to fully faded. */
export function endDuration(hand: boolean, reason: EndReason) {
  const dur = hand ? SLIP.settleMs : MORPH_TOTAL;
  const hold = SLIP.holdMs * (reason === "error" ? 2.5 : 1);
  return dur + SLIP.widenMs + hold + SLIP.exitMs;
}

function endedFrame(s: Session, E: End, now: number, en: number): Frame {
  const u = now - E.t;
  const f = outCubic(cl(u / SLIP.settleMs));
  let a: number[];
  let e: number[];
  let op: number;
  let wStart: number;
  if (E.hand) {
    // The hand closes.
    a = ONE6;
    e = ONE6;
    op = lerp(1, 0.62, f);
    wStart = 80;
  } else {
    // The dots land as a closed hand.
    const mo = morph(E.clock0 + u, SLIP.morphMs);
    a = mo.a;
    e = mo.e;
    op = lerp(1, 0.62, cl(mo.a[5]));
    wStart = SLIP.morphMs * 0.4;
  }
  const k = E.k0.map((v) => lerp(v, 0.08, f));
  const wp = outCubic(cl((u - wStart) / SLIP.widenMs));
  const exitAt = Math.min(
    E.t + endDuration(E.hand, E.reason) - SLIP.exitMs,
    s.tExit ?? Infinity,
  );
  const ex = outCubic(cl((now - exitAt) / SLIP.exitMs));
  const text =
    E.text && u < 140
      ? { ...E.text, op: E.text.op * (1 - cl(u / 120)), shift: 0 }
      : null;
  const mop = cl((u - wStart - SLIP.widenMs * 0.5) / 150);
  return {
    phase: "ended",
    done: now >= exitAt + SLIP.exitMs,
    mark: {
      tSrc: now - s.t0,
      asg: E.asg,
      a,
      e,
      k,
      rip: [0, 0, 0, 0],
      op,
      headAmber: 0,
      badge:
        E.reason === "error" ? outBack(cl((u - SLIP.morphMs * 0.6) / 220)) : 0,
    },
    card: {
      op: en * (1 - ex),
      dy: SLIP.rise * (1 - en) + SLIP.rise * ex,
      w: lerp(E.box.w, E.msgW, wp),
      h: lerp(E.box.h, cardHeight(LINE), wp),
      r: lerp(E.box.r, 23, wp),
      pr: lerp(E.box.pr, 17, wp),
    },
    text,
    msg: !text && mop > 0 ? { op: mop, reason: E.reason } : null,
  };
}

/** Line endpoints, width, opacity and amber mix for each part, as the playground draws them. */
export function drawParts(m: Mark) {
  const dw = SLIP.dotSize * UNIT;
  const N = SLIP.dots;
  const tailOp = (s: number) => 1 - SLIP.tail * (1 - s / Math.max(1, N - 1));
  return PARTS.map((p, j) => {
    const s = m.asg[j];
    const a = m.a[j];
    const e = Math.max(0, m.e[j]);
    const ac = cl(a);
    const free = s < 0; // no dot for this part: it grows in place
    const src = free ? p.b : circ(s, m.tSrc);
    const x = lerp(src[0], p.b[0], a);
    const y = lerp(src[1], p.b[1], a);
    let x1 = x;
    let y1 = y;
    let x2 = x + 0.01;
    let y2 = y;
    if (j === 5) {
      const hx = ((p.tB![0] - p.tA![0]) / 2) * e;
      const hy = ((p.tB![1] - p.tA![1]) / 2) * e;
      x1 = x - hx;
      y1 = y - hy;
      x2 = x + hx + 0.01;
      y2 = y + hy;
    } else {
      const k = j === 0 ? e : e * (m.k[j - 1] + m.rip[j - 1]);
      x2 = x + (p.tip![0] - p.b[0]) * k + 0.01;
      y2 = y + (p.tip![1] - p.b[1]) * k;
    }
    // The thumb is never amber; only the head dot is, while polishing.
    const amber = s === N - 1 ? m.headAmber * (1 - ac) : 0;
    return {
      x1,
      y1,
      x2,
      y2,
      width: lerp(dw, p.w, free ? cl(e * 1.6) : ac),
      op: free ? cl(e * 4) : lerp(tailOp(s), 1, ac),
      amber,
    };
  });
}
