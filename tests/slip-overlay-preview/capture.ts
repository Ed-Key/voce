// Captures the motion playground and this harness at the same moments with
// headless Chrome, crops both to the overlay window (480 x 110 pt at 2x) and
// stacks them: playground on top, the real component below.
//
// Needs the harness served first: bunx vite dev --port 1433 --strictPort
// Run: bun tests/slip-overlay-preview/capture.ts <playground index.html> <out dir> [filter]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { COMMIT_TIMES } from "./script";

const [playground, outDir, filter] = process.argv.slice(2);
if (!playground || !outDir) {
  console.error("usage: capture.ts <playground index.html> <out dir> [filter]");
  process.exit(2);
}
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HARNESS = "http://localhost:1433/tests/slip-overlay-preview/index.html";
const APPROVED = {
  dots: 5,
  radius: 6.5,
  dotSize: 2.9,
  spin: 1.1,
  tail: 0.55,
  armMs: 700,
  morphMs: 520,
  stagger: 45,
  ease: "outCubic",
  travel: "swirl",
  landMs: 250,
  settleMs: 380,
  attack: 45,
  release: 220,
  gain: 1.3,
  maxLen: 1,
  restLen: 0.28,
  spread: 0.5,
  thumb: "off",
  amberMs: 200,
  polish: "head",
  polishDim: 0.62,
  transMs: 500,
  polishMs: 900,
  enterMs: 140,
  exitMs: 160,
  rise: 6,
  widenMs: 240,
  turnMs: 220,
  wpm: 165,
  holdMs: 900,
  glyph: 22,
  react: "nod",
  noise: "off",
  gateTh: 0.12,
  gateHold: 250,
  lagMs: 600,
  nodStyle: "ripple",
  nodSize: 0.5,
  nodMs: 130,
  nodEase: "snap",
};

// [timeline, playground ms, label]
const nod = Math.round(COMMIT_TIMES[6]);
const FRAMES: [string, number, string][] = [
  ["main", 60, "enter"],
  ["main", 400, "arming"],
  ["main", 950, "morph"],
  ["main", 1300, "morph-late"],
  ["main", 1700, "landed"],
  ["main", 2300, "first-words"],
  ["main", nod + 30, "nod"],
  ["main", 4200, "one-line"],
  ["main", 6500, "two-lines"],
  ["main", 18200, "release"],
  ["main", 18800, "finishing"],
  ["main", 19500, "polishing"],
  ["main", 20040, "paste-exit"],
  ["cancel", 1000, "hand-closing"],
  ["cancel", 1300, "narrowing"],
  ["cancel", 1800, "message"],
  ["cancel", 2500, "exit"],
  ["empty", 900, "dots-land"],
  ["empty", 1300, "widen"],
  ["empty", 2000, "message"],
  ["error", 1100, "badge"],
  ["error", 2000, "message"],
];

function shot(url: string, file: string, size: string) {
  execFileSync(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      "--virtual-time-budget=60000",
      `--screenshot=${file}`,
      `--window-size=${size}`,
      url,
    ],
    { stdio: "ignore" },
  );
}

fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(outDir, ".raw-"));
const set = encodeURIComponent(JSON.stringify(APPROVED));
for (const bg of ["dark", "light"]) {
  for (const [tl, t, label] of FRAMES) {
    const name = `${tl}-${String(t).padStart(5, "0")}-${label}-${bg}`;
    if (filter && !name.includes(filter)) continue;
    const pg = path.join(tmp, `${name}-pg.png`);
    const hv = path.join(tmp, `${name}-hv.png`);
    shot(
      `file://${path.resolve(playground)}#t=${t}&tl=${tl}&bg=${bg}&set=${set}`,
      pg,
      "1200,420",
    );
    shot(`${HARNESS}#t=${t}&tl=${tl}&bg=${bg}`, hv, "520,250");
    // Playground strip is at (24, 148); the window box sits 20 px in and 92 px down.
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      pg,
      "-i",
      hv,
      "-filter_complex",
      "[0]crop=960:220:88:480,pad=iw:ih+4:0:0:white[a];[1]crop=960:220:40:184[b];[a][b]vstack=inputs=2",
      path.join(outDir, `${name}.png`),
    ]);
    console.log(name);
  }
}
fs.rmSync(tmp, { recursive: true });
