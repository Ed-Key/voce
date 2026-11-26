import assert from "node:assert/strict";
import { humanDuration } from "./duration";

const words = (key: string, { n }: { n: number }) =>
  `${n} ${key.split(".").pop()}`;
const at = (mmss: string) => {
  const [m, s] = mmss.split(":").map(Number);
  return (m * 60 + s) * 1000;
};

assert.deepEqual(
  ["78:28", "90:00", "1:24", "33:47", "0:09", "62:44", "60:00", "59:45"].map(
    (x) => humanDuration(at(x), words),
  ),
  [
    "1 hr 18 min",
    "1 hr 30 min",
    "1 min",
    "34 min",
    "9 sec",
    "1 hr 3 min",
    "1 hr",
    "1 hr",
  ],
);
console.log("duration ok");
