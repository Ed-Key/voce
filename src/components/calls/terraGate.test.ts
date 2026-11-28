// Terra gate rows 9 to 11: run with `bun src/components/calls/terraGate.test.ts`.
import assert from "node:assert/strict";
import { TABS, tabAfterSwitch, terraOn, visibleTabs } from "./terraGate";

// Row 11: the Memory sidebar entry (and every other Terra mount) follows the switch; off by default.
assert.equal(terraOn(undefined), false);
assert.equal(terraOn({}), false);
assert.equal(terraOn({ experimental_enabled: false }), false);
assert.equal(terraOn({ experimental_enabled: true }), true);

// Row 9: the Terra tab and the System view (Terra's pipeline diagram) exist only while the switch is on, and
// keyboard navigation uses the same list.
assert.deepEqual(visibleTabs(true), TABS);
assert.deepEqual(visibleTabs(false), ["notes", "transcript"]);

// Row 10: a page on the Terra tab shows Notes once the switch goes off; other tabs stay put.
assert.equal(tabAfterSwitch("terra", false), "notes");
assert.equal(tabAfterSwitch("system", false), "notes");
assert.equal(tabAfterSwitch("transcript", false), "transcript");
assert.equal(tabAfterSwitch("terra", true), "terra");

console.log("terraGate: all rows pass");
