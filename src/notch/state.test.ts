import assert from "node:assert/strict";
import type { AssistieSnapshot } from "../components/calls/AssistiePanel";
import { notchPhase, selectableReply } from "./state";

const base: AssistieSnapshot = {
  run_id: "fictional", status: "following", sharing: true, proactive: true,
  deadline_ms: 1, startup_deadline_ms: null, version: 2, context_brief: null,
  questions: [], replies: [
    { event_id: "q1", question_id: 1, kind: "answer", version: 2, text: "Monday", quotes: [] },
    { event_id: "p2", question_id: null, kind: "pointer", version: 2, text: "Correct the draft", quotes: [] },
  ],
};
assert.equal(selectableReply(base)?.event_id, "p2");
assert.equal(selectableReply({ ...base, proactive: false })?.event_id, "q1");
assert.equal(selectableReply({ ...base, sharing: false }), undefined);
assert.equal(selectableReply({ ...base, status: "expired" }), undefined);
assert.equal(selectableReply({ ...base, version: 3 }), undefined);
assert.equal(notchPhase({ ...base, sharing: false }, false), "stopped");
assert.equal(notchPhase(base, true), "unavailable");
assert.equal(notchPhase({ ...base, questions: [{ id: 2, text: "Date?", version: 2, status: "pending" }] }, false), "thinking");
console.log("Notch state gates: 8 assertions passed");

const asOfReply = { ...base.replies[0], snapshot_at_ms: 1700000000000 };
const liveSnapshot = { ...base, call_id: "fictional-live", version: 3, replies: [asOfReply] };
assert.equal(selectableReply(liveSnapshot)?.event_id, asOfReply.event_id, "timestamped live snapshots survive appended speech");
assert.equal(selectableReply({ ...liveSnapshot, sharing: false }), undefined, "a snapshot timestamp never overrides revoked consent");
assert.equal(selectableReply({ ...liveSnapshot, proactive: false, replies: [{ ...asOfReply, kind: "pointer" }] }), undefined, "old snapshot pointers remain hidden when pointers are off");

console.log("Live snapshot gates: 3 assertions passed");

const historical = { ...asOfReply, source_status: "outside_window" as const };
assert.equal(selectableReply({ ...liveSnapshot, replies: [historical] })?.event_id, historical.event_id, "completed historical answers remain readable in the active notch");
assert.equal(selectableReply({ ...liveSnapshot, status: "disabled", replies: [historical] }), undefined, "historical answers cannot keep a stopped notch alive");
console.log("Historical answer gates: 2 assertions passed");

const failed = { ...base, questions: [{ id: 3, text: "Owner?", version: 2, status: "failed" }] };
assert.equal(selectableReply(failed), undefined, "an earlier answer never stands in for a failed question");
assert.equal(notchPhase(failed, false), "failed");
const later = { ...failed, version: 3, replies: [...base.replies, { event_id: "p3", question_id: null, kind: "pointer", version: 3, text: "New pointer", quotes: [] }] };
assert.equal(selectableReply(later)?.event_id, "p3", "a pointer after the failure still shows");
console.log("Failed question gates: 3 assertions passed");
