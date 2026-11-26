import assert from "node:assert/strict";
import type { AssistieSnapshot } from "./AssistiePanel";
import { canRate, markFor } from "./rating";

type Mark = NonNullable<AssistieSnapshot["marks"]>[number];
const mark = (fields: Partial<Mark>): Mark => ({
  id: "m1",
  event_id: null,
  rating: "missed",
  note: "",
  at_ms: 100,
  status: "saved",
  ...fields,
});
const reply = {
  event_id: "q1",
  snapshot_at_ms: 50,
} as AssistieSnapshot["replies"][number];
const live = {
  transport: "codex",
  sharing: true,
  status: "following",
  archive: false,
} as AssistieSnapshot;

// Nothing is selected before the user marks anything.
const none = {
  rating: null,
  missed: false,
  ratingFailed: false,
  missedFailed: false,
};
assert.deepEqual(markFor([], reply), none);
assert.deepEqual(markFor(undefined, reply), none);
// The latest mark on this reply wins; marks on other replies are ignored.
assert.equal(
  markFor(
    [
      mark({ id: "m1", event_id: "q1", rating: "good" }),
      mark({ id: "m2", event_id: "q1", rating: "bad" }),
    ],
    reply,
  ).rating,
  "bad",
);
assert.equal(
  markFor([mark({ event_id: "q2", rating: "good" })], reply).rating,
  null,
);
// A failed save is reported for the mark that is showing.
assert.equal(
  markFor([mark({ event_id: "q1", rating: "good", status: "failed" })], reply)
    .ratingFailed,
  true,
);
assert.equal(
  markFor(
    [
      mark({ event_id: "q1", rating: "good", status: "failed" }),
      mark({ id: "m2", event_id: "q1", rating: "bad" }),
    ],
    reply,
  ).ratingFailed,
  false,
);
// "Missed" shows for moments after this reply's context, not before it.
assert.equal(markFor([mark({ at_ms: 100 })], reply).missed, true);
assert.equal(markFor([mark({ at_ms: 10 })], reply).missed, false);
// A failed missed moment is its own failure, never the reply's rating failure.
const failedMoment = markFor(
  [
    mark({ event_id: "q1", rating: "good" }),
    mark({ id: "m2", at_ms: 100, status: "failed" }),
  ],
  reply,
);
assert.equal(failedMoment.missedFailed, true);
assert.equal(failedMoment.ratingFailed, false);
console.log("Mark selection: 10 assertions passed");

// Ratings are offered only while Terra itself is following live: the bridge refuses the rest.
assert.equal(canRate(live), true);
assert.equal(canRate({ ...live, status: "waiting" }), true);
assert.equal(canRate(null), false);
assert.equal(canRate({ ...live, transport: "plugin" }), false);
assert.equal(canRate({ ...live, sharing: false }), false);
assert.equal(canRate({ ...live, status: "disabled" }), false);
assert.equal(canRate({ ...live, archive: true }), false);
console.log("Rating availability: 7 assertions passed");
