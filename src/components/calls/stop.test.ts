import assert from "node:assert/strict";
import { reconcileStopped, stopThenSave } from "./stop";

const events: string[] = [];
const errors: unknown[] = [];
assert.equal(
  await stopThenSave(
    async () => {
      events.push("stopped");
      return "session";
    },
    async () => {
      events.push("save");
      throw new Error("disk full");
    },
    (error) => errors.push(error),
  ),
  "session",
);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(events, ["stopped", "save"]);
assert.equal(errors.length, 1);
assert.equal(
  await stopThenSave(
    async () => "stopped",
    () => new Promise(() => {}),
    () => {},
  ),
  "stopped",
);
let saved = false;
await assert.rejects(
  stopThenSave(
    async () => {
      throw new Error("stop failed");
    },
    async () => {
      saved = true;
    },
    () => {},
  ),
);
assert.equal(saved, false);
console.log("Stop: failed or stalled notes never block capture stop");
const stale = { id: "call", active: true };
const stopped = { id: "call", active: false };
assert.deepEqual(reconcileStopped([stale], stopped), [stopped]);
assert.deepEqual(reconcileStopped([stopped], stale), [stopped]);
assert.deepEqual(reconcileStopped([stale], { id: "another", active: false }), [
  stale,
]);
