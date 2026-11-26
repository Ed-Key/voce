// One check per row of docs/overlay-lifecycle.md (webview side). Run: bun src/overlay/slip.test.ts
import assert from "node:assert/strict";
import {
  type Context,
  type OverlayEvent,
  type Session,
  LINE,
  PILL_W,
  SLIP,
  SLIP_W,
  drawParts,
  endDuration,
  frameAt,
  newLevelInput,
  readLevels,
  reduce,
} from "./slip";

const LV = [0.5, 0.5, 0.5, 0.5];
const ctx: Context = { lv: LV, msgW: () => 150 };
const apply = (s: Session | null, ev: OverlayEvent, now: number) =>
  reduce(s, ev, now, ctx);
const at = (s: Session, now: number) => frameAt(s, now, LV);

// A session that is listening with the hand landed: press at 0, audio at 100.
function listening() {
  let s = apply(null, { type: "show", state: "streaming" }, 0)!;
  s = apply(s, { type: "ready" }, 100)!;
  return s;
}
const LISTEN_AT = 100 + 655 + 250 + 260 + 10;

// press
{
  const s = apply(null, { type: "show", state: "streaming" }, 0)!;
  const f = at(s, 2000);
  assert.equal(f.phase, "arming");
  assert.equal(f.card.w, PILL_W);
  assert.equal(f.mark.a[5], 0, "dots, no hand, while no audio has arrived");
  assert.equal(f.done, false);
  assert.equal(at(s, 0).card.op, 0, "card fades in");
  assert.equal(at(s, SLIP.enterMs).card.op, 1);
}

// first audio
{
  const s = listening();
  assert.equal(at(s, 300).phase, "morph");
  const f = at(s, LISTEN_AT);
  assert.equal(f.phase, "listening");
  assert.deepEqual(f.mark.a, [1, 1, 1, 1, 1, 1]);
  const k = SLIP.restLen + (SLIP.maxLen - SLIP.restLen) * 0.5;
  assert.ok(
    Math.abs(f.mark.k[0] - k) < 1e-9,
    "fingers follow the level once landed",
  );
  // a second ready (or one after release) changes nothing
  apply(s, { type: "ready" }, 900);
  assert.equal(s.tAudio, 100);
}

// words commit
{
  const s = listening();
  apply(s, { type: "text", committed: "", tentative: "Okay" }, 1500);
  assert.equal(s.commits.length, 0, "tentative words do not nod");
  assert.equal(s.tText, 1500, "first text widens the pill");
  assert.equal(at(s, 1500 + SLIP.widenMs).card.w, SLIP_W);
  apply(s, { type: "text", committed: "Okay", tentative: "so" }, 2000);
  assert.equal(s.commits.length, 1);
  assert.ok(at(s, 2030).mark.rip[0] > 0, "the ripple nods");
  assert.equal(at(s, 2000 + SLIP.nodMs + 200).mark.rip[3], 0, "and settles");
  apply(s, { type: "text", committed: "Okay", tentative: "so for" }, 2100);
  assert.equal(s.commits.length, 1, "no nod without a new committed word");
  // Lines: growth turns the new line in, a shortening rewrite snaps.
  apply(s, { type: "lines", n: 2 }, 3000);
  assert.equal(at(s, 3000).text!.shift, LINE);
  assert.equal(at(s, 3000 + SLIP.turnMs).text!.shift, 0);
  assert.equal(at(s, 3000 + SLIP.turnMs).card.h, 2 * LINE + 24);
  apply(s, { type: "lines", n: 1 }, 3500);
  assert.equal(at(s, 3500).text!.shift, 0);
  assert.equal(at(s, 3500).card.h, LINE + 24);
}

// release
{
  const s = listening();
  apply(s, { type: "phase", kind: "transcribing" }, 3000);
  assert.equal(at(s, 3100).phase, "release");
  const f = at(s, 3000 + 515);
  assert.equal(f.phase, "finishing");
  assert.equal(f.mark.a[5], 0, "back to dots");
  // The compact overlay reports release as a show state.
  const c = listening();
  apply(c, { type: "show", state: "transcribing" }, 3000);
  assert.equal(c.tRelease, 3000);
  // Releasing mid-morph starts the release part way, not from a full hand.
  const m = listening();
  apply(m, { type: "phase", kind: "transcribing" }, 300);
  assert.ok(m.relFrom > 0 && m.relFrom < 515);
}

// polish
{
  const s = listening();
  apply(s, { type: "text", committed: "Okay", tentative: "" }, 1500);
  apply(s, { type: "phase", kind: "transcribing" }, 3000);
  apply(s, { type: "phase", kind: "polishing" }, 3600);
  const f = at(s, 3600 + 150);
  assert.equal(f.phase, "polishing");
  assert.equal(f.mark.headAmber, 1);
  assert.equal(f.text!.dim, SLIP.polishDim);
  const parts = drawParts(f.mark);
  assert.equal(
    parts.filter((p) => p.amber > 0).length,
    1,
    "only the head dot is amber",
  );
  // Once the dots are a hand nothing is amber, the thumb included.
  const hand = { ...at(listening(), LISTEN_AT).mark, headAmber: 1 };
  assert.ok(
    drawParts(hand).every((p) => p.amber === 0),
    "the thumb is never amber",
  );
}

// polish done: no event; it holds until paste
{
  const s = listening();
  apply(s, { type: "phase", kind: "polishing" }, 3000);
  const f = at(s, 9000);
  assert.equal(f.phase, "polishing");
  assert.equal(f.done, false);
}

// paste
{
  const s = listening();
  apply(s, { type: "phase", kind: "transcribing" }, 3000);
  apply(s, { type: "hide" }, 4000);
  assert.equal(at(s, 4050).phase, "exiting");
  assert.equal(at(s, 4000 + SLIP.exitMs - 1).done, false);
  assert.equal(
    at(s, 4000 + SLIP.exitMs).done,
    true,
    "gone within the 300 ms Rust hide",
  );
  assert.equal(at(s, 4000 + SLIP.exitMs).card.op, 0);
}

// cancel while listening: the hand closes
{
  const s = listening();
  apply(s, { type: "text", committed: "Okay so", tentative: "for" }, 1500);
  apply(s, { type: "ended", reason: "cancelled" }, 3000);
  assert.equal(s.end!.hand, true);
  assert.ok(
    Math.abs(at(s, 3000 + SLIP.settleMs).mark.k[0] - 0.08) < 1e-9,
    "fingers closed",
  );
  assert.ok(
    Math.abs(at(s, 3000 + SLIP.settleMs).mark.op - 0.62) < 1e-9,
    "hand fades as one group",
  );
  const m = at(s, 3000 + 600);
  assert.equal(m.msg?.reason, "cancelled");
  assert.equal(m.text, null);
  assert.equal(m.card.w, 150);
  const total = endDuration(true, "cancelled");
  assert.equal(total, 380 + 240 + 900 + 160);
  assert.equal(at(s, 3000 + total - 1).done, false);
  assert.equal(at(s, 3000 + total).done, true);
  assert.ok(total <= 2050, "inside the Rust linger");
  // later text and phase events cannot reopen it
  apply(s, { type: "text", committed: "Okay so for", tentative: "" }, 3100);
  assert.equal(s.words, 2);
}

// nothing heard after release: the dots land as a closed hand
{
  const s = listening();
  apply(s, { type: "phase", kind: "transcribing" }, 3000);
  apply(s, { type: "ended", reason: "nothing_heard" }, 4000);
  assert.equal(s.end!.hand, false);
  assert.equal(at(s, 4000).mark.a[5], 0);
  assert.equal(at(s, 4000 + 655).mark.a[5], 1);
  assert.equal(at(s, 4000 + 1000).msg?.reason, "nothing_heard");
  const total = endDuration(false, "nothing_heard");
  assert.equal(total, 655 + 240 + 900 + 160);
  assert.ok(total <= 2050, "inside the Rust linger");
  assert.equal(at(s, 4000 + total).done, true);
}

// error: holds 2.5x and shows the amber dot
{
  const s = listening();
  apply(s, { type: "phase", kind: "transcribing" }, 3000);
  apply(s, { type: "ended", reason: "error" }, 4000);
  assert.ok(at(s, 4000 + 312 + 220).mark.badge > 0.99);
  const total = endDuration(false, "error");
  assert.equal(total, 655 + 240 + 2250 + 160);
  assert.ok(total <= 3400, "inside the Rust linger");
  assert.equal(at(s, 4000 + total - 200).done, false);
  assert.equal(at(s, 4000 + total).done, true);
}

// second end in one session: the first wins
{
  const s = listening();
  apply(s, { type: "ended", reason: "cancelled" }, 3000);
  apply(s, { type: "ended", reason: "error" }, 3100);
  assert.equal(s.end!.reason, "cancelled");
  // a late hide fades it out at once
  apply(s, { type: "hide" }, 3200);
  assert.equal(at(s, 3200 + SLIP.exitMs).done, true);
}

// new press during a lingering end: a fresh session
{
  const s = listening();
  apply(s, { type: "ended", reason: "cancelled" }, 3000);
  const next = apply(s, { type: "show", state: "recording" }, 3500)!;
  assert.notEqual(next, s);
  assert.equal(at(next, 3600).phase, "arming");
  assert.equal(next.end, null);
}

// model unavailable: never shown, so nothing else shows it
{
  assert.equal(apply(null, { type: "ready" }, 0), null);
  assert.equal(apply(null, { type: "ended", reason: "cancelled" }, 0), null);
  assert.equal(apply(null, { type: "hide" }, 0), null);
  assert.equal(
    apply(null, { type: "text", committed: "a", tentative: "" }, 0),
    null,
  );
}

// levels: steady room tone reads as silence, speech above it as loud
{
  const inp = newLevelInput();
  const bucket = (f: number) => Math.pow(f * 1.3, 0.7);
  for (let t = 0; t < 3000; t += 33)
    readLevels(inp, Array(16).fill(bucket(0.45)), t);
  assert.ok(inp.loud < 0.01, "room tone is silence");
  readLevels(inp, Array(16).fill(bucket(0.72)), 3033);
  assert.ok(inp.loud > 0.85, "speech is loud");
}

console.log("slip overlay: all assertions passed");
