import { expect, test, type Page } from "@playwright/test";

// Board states from the chat notch design; NOTCH_SHOTS saves a crop of each.
const page = (state: string) =>
  `/tests/assistie-notch-preview/index.html?state=${state}`;
async function shot(p: Page, name: string) {
  if (process.env.NOTCH_SHOTS)
    await p
      .locator("#stage")
      .screenshot({ path: `${process.env.NOTCH_SHOTS}/${name}.png` });
}
async function notClipped(p: Page, selector: string) {
  const clipped = await p.$$eval(selector, (nodes) =>
    nodes
      .filter((n) => n.scrollWidth > n.clientWidth + 1)
      .map((n) => n.textContent),
  );
  expect(clipped).toEqual([]);
}
const events = (p: Page) => p.locator("#events");
const unseen = (p: Page) => p.locator('.notch-hidden[role="status"]');

test("quiet: the dot and flat level bars, no words", async ({ page: p }) => {
  await p.goto(page("quiet"));
  await expect(p.locator(".terra-mark")).toBeVisible();
  await expect(p.locator(".notch-wave i")).toHaveCount(7);
  await expect(p.locator(".notch-wave")).not.toHaveClass(/live/);
  await expect(p.locator(".notch-handle")).toHaveText("");
  await shot(p, "1-quiet");
});

test("thinking: the dot becomes the thought orb", async ({ page: p }) => {
  await p.goto(page("thinking"));
  await expect(p.locator(".notch-handle .terra-orb")).toBeVisible();
  await shot(p, "2-thinking");
});

test("pointer: one line with +1, nothing clipped", async ({ page: p }) => {
  await p.goto(page("pointer"));
  await expect(p.locator(".notch-line-text")).toHaveText(
    "Kenji owns the review, per your notes from Oct 28.",
  );
  await expect(p.locator(".notch-more")).toHaveText("+1");
  await notClipped(p, ".notch-line-text");
  await shot(p, "3-pointer");
});

test("closed: the dot stays and the count is only for screen readers", async ({
  page: p,
}) => {
  await p.goto(page("closed"));
  await expect(unseen(p)).toHaveText("2 unseen replies");
  await expect(p.locator(".terra-mark")).toBeVisible();
  await expect(p.locator(".notch-handle")).toHaveText("");
  await expect(unseen(p)).toHaveCSS("width", "1px");
  await shot(p, "4-closed-unseen");
});

test("ended: a check and Saved", async ({ page: p }) => {
  await p.goto(page("ended"));
  await expect(p.locator(".terra-check")).toBeVisible();
  await expect(p.locator(".notch-saved")).toHaveText("Saved");
  await shot(p, "5-ended");
});

test("open: the chat, sources nested, unseen tracked, then seen after 1.5 s", async ({
  page: p,
}) => {
  await p.goto(page("open"));
  // The chat is in the DOM (hidden) before it opens, so wait for the open state itself.
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  await p.waitForTimeout(400);
  await expect(p.locator(".chat-row.you .chat-bubble")).toHaveText(
    "Who approves the budget?",
  );
  await expect(p.locator(".chat-row.answer .chat-quote.them small")).toHaveText(
    "Them · 38:12",
  );
  await expect(p.locator(".chat-row[data-unseen]")).toHaveCount(2);
  await notClipped(p, ".chat-bubble");
  await shot(p, "6-open");
  await expect(events(p)).toContainText("log seen 3", { timeout: 4000 });
  await expect(events(p)).toContainText("log seen 4");
  await expect(p.locator(".chat-row[data-unseen]")).toHaveCount(0);
});

test("closing within 1.5 s leaves replies unseen", async ({ page: p }) => {
  await p.goto(page("closed"));
  await p.click("#native-enter");
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  // Escape needs focus inside the notch; the chevron runs the same dismiss path.
  await p.getByRole("button", { name: "Collapse Terra" }).click();
  await p.waitForTimeout(2000);
  // Under load the click can land late, so check timing rather than absence: a reply may only be
  // marked seen while the chat was open and at least 1.5 s after it opened, never after it closed.
  const lines = ((await events(p).textContent()) ?? "").split("\n");
  const at = (label: string) =>
    lines.filter((l) => l.endsWith(label)).map((l) => Number(l.split(" ")[0]));
  const opened = at("layout expanded")[0];
  const closed = at("layout compact").filter((t) => t > opened)[0];
  for (const n of [1, 2])
    for (const t of at(`log seen ${n}`)) {
      expect(t - opened).toBeGreaterThanOrEqual(1500);
      expect(t).toBeLessThanOrEqual(closed);
    }
});

test("hover opens after the dwell; leaving closes after the grace unless pinned", async ({
  page: p,
}) => {
  await p.goto(page("quiet"));
  await p.click("#native-enter");
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible({
    timeout: 1000,
  });
  // The dwell, read from the page's own clock so a slow click cannot fake or break it.
  const lines = ((await events(p).textContent()) ?? "").split("\n");
  const at = (label: string) =>
    Number(lines.find((l) => l.endsWith(label))?.split(" ")[0]);
  expect(
    at("layout expanded") - at("native pointer enter"),
  ).toBeGreaterThanOrEqual(430);
  await p.click("#native-leave");
  await expect(p.locator(".assistie-notch.expanded")).toHaveCount(0, {
    timeout: 1000,
  });
  await p.click("#native-enter");
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible({
    timeout: 1000,
  });
  await p.getByRole("button", { name: "Keep open" }).click();
  await p.click("#native-leave");
  await p.waitForTimeout(600);
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
});

test("scrolled up, a new reply keeps your place and shows a new marker", async ({
  page: p,
}) => {
  await p.goto(page("open"));
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  for (let i = 0; i < 6; i++) await p.click("#pointer");
  const chat = p.locator(".notch-chat");
  await expect(p.locator(".chat-row.terra")).toHaveCount(10);
  await chat.evaluate((el) => (el.scrollTop = 0));
  await p.waitForTimeout(200);
  const before = await chat.evaluate((el) => el.scrollTop);
  await p.click("#pointer");
  await expect(p.locator(".chat-new")).toHaveText("1 new");
  expect(await chat.evaluate((el) => el.scrollTop)).toBe(before);
  await p.locator(".chat-new").click();
  await expect(p.locator(".chat-new")).toHaveCount(0);
});

test("asking: your bubble, Terra typing, then the answer", async ({
  page: p,
}) => {
  await p.goto(page("open"));
  await p.getByPlaceholder("Ask anything").fill("Is Monday agreed?");
  await p.keyboard.press("Enter");
  await expect(p.locator(".chat-typing")).toBeVisible();
  await expect(p.locator(".chat-row.answer").last()).toContainText(
    "Monday is agreed.",
    { timeout: 4000 },
  );
  await expect(p.locator(".chat-row.you .chat-bubble").last()).toHaveText(
    "Is Monday agreed?",
  );
});

test("stop shows Saved, then the notch hides", async ({ page: p }) => {
  await p.goto(page("open"));
  await p.getByRole("button", { name: "Stop sharing" }).last().click();
  await expect(p.locator(".notch-saved")).toHaveText("Saved");
  await expect(p.locator("#stage")).toBeHidden({ timeout: 6000 });
});

test("a reply published while sharing was paused still arrives after it resumes", async ({
  page: p,
}) => {
  await p.goto(page("closed"));
  await expect(unseen(p)).toHaveText("2 unseen replies");
  await p.click("#pause");
  await p.click("#pointer");
  await p.waitForTimeout(1500);
  await p.click("#pause");
  await expect(p.locator("#events")).toContainText("log shown 3", {
    timeout: 4000,
  });
});

test("a failed first read is retried", async ({ page: p }) => {
  await p.goto(`${page("closed")}&feedfail`);
  await expect(unseen(p)).toHaveText("2 unseen replies", { timeout: 6000 });
});

test("a pointer held while you talk does not peek once the call has ended", async ({
  page: p,
}) => {
  await p.goto(page("quiet"));
  await p.click("#talk");
  await p.waitForTimeout(1200);
  await p.click("#pointer");
  await p.waitForTimeout(1200);
  await p.click("#stop");
  await p.waitForTimeout(1200);
  await p.click("#talk");
  await p.waitForTimeout(1500);
  await expect(p.locator(".notch-line")).toHaveCount(0);
  await expect(p.locator(".notch-saved")).toHaveText("Saved");
});

test("a new reply does not restart the seen timer of a row already in view", async ({
  page: p,
}) => {
  await p.goto(page("open"));
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  const opened = Date.now();
  await p.waitForTimeout(900);
  await p.click("#pointer");
  await expect(p.locator("#events")).toContainText("log seen 3", {
    timeout: 4000,
  });
  expect(Date.now() - opened).toBeLessThan(2400);
});

test("a passing read error does not end an answer's peek", async ({
  page: p,
}) => {
  await p.goto(page("quiet"));
  await p.click("#reply");
  await expect(p.locator(".notch-line-text")).toContainText("Priya approves");
  await p.click("#fail-next");
  await p.click("#pointer");
  await p.waitForTimeout(2500);
  await expect(p.locator(".notch-line-text")).toContainText("Priya approves");
});

test("a reply counts as seen only after 1.5 s in view", async ({ page: p }) => {
  await p.goto(page("open"));
  await expect(p.locator("#events")).toContainText("log seen 3", {
    timeout: 5000,
  });
  const text = (await p.locator("#events").textContent()) ?? "";
  const stamp = (label: string) =>
    Number(text.match(new RegExp(`(\\d+) ${label}`))?.[1]);
  expect(stamp("log seen 3") - stamp("layout expanded")).toBeGreaterThanOrEqual(
    1500,
  );
});

test("closing the chat right away does not mark a kept peek as seen", async ({
  page: p,
}) => {
  await p.goto(page("pointer"));
  await expect(p.locator(".notch-more")).toHaveText("+1");
  await p.click("#native-enter");
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  await p.getByRole("button", { name: "Collapse Terra" }).click();
  await p.waitForTimeout(500);
  await expect(p.locator("#events")).not.toContainText("dismissed");
  // The peek may still be seen by its own 1.5 s reading timer, never by the close itself.
  const text = (await p.locator("#events").textContent()) ?? "";
  const stamp = (label: string) =>
    Number(text.match(new RegExp(`(\\d+) ${label}`))?.[1]);
  if (text.includes("log seen 2"))
    expect(stamp("log seen 2") - stamp("log shown 2")).toBeGreaterThanOrEqual(
      1500,
    );
});

test("replies that land while the notch is hidden only add to the count", async ({
  page: p,
}) => {
  await p.goto(page("closed"));
  await expect(unseen(p)).toHaveText("2 unseen replies");
  await p.click("#native-enter");
  await p.getByRole("button", { name: "Hide notch" }).click();
  await expect(p.locator("#stage")).toBeHidden();
  await p.click("#pointer");
  await p.click("#pointer");
  await p.click("#show");
  await expect(unseen(p)).toHaveText("4 unseen replies");
  await p.waitForTimeout(1500);
  await expect(p.locator(".notch-line")).toHaveCount(0);
  await expect(p.locator("#events")).not.toContainText("log shown");
});

test("the level bars move with call audio, in Terra teal", async ({
  page: p,
}) => {
  await p.goto(page("quiet"));
  const tallest = () =>
    p.$$eval(".notch-wave i", (bars) =>
      Math.max(...bars.map((b) => b.getBoundingClientRect().height)),
    );
  const send = (levels: number[]) =>
    p.evaluate(
      (l) =>
        (
          window as unknown as { notchLevels: (l: number[]) => void }
        ).notchLevels(l),
      levels,
    );
  expect(await tallest()).toBeLessThanOrEqual(3);
  // Room noise on a MacBook mic (about -40 dB) stays flat and dim.
  for (let i = 0; i < 4; i++) {
    await send([0.01, 0]);
    await p.waitForTimeout(60);
  }
  await expect(p.locator(".notch-wave")).not.toHaveClass(/live/);
  expect(await tallest()).toBeLessThanOrEqual(3);
  // Speech (about -26 dB) rises clearly.
  for (let i = 0; i < 6; i++) {
    await send([0.05, 0]);
    await p.waitForTimeout(60);
  }
  await expect(p.locator(".notch-wave")).toHaveClass(/live/);
  expect(await tallest()).toBeGreaterThan(6);
  await send([0, 0]);
  await expect(p.locator(".notch-wave")).not.toHaveClass(/live/);
});

test("the orb shows while Terra works on anything, but never for a quick check", async ({
  page: p,
}) => {
  await p.goto(page("quiet"));
  const orb = p.locator(".notch-handle .terra-orb");
  // A quick check (under 600 ms) never shows the orb.
  await p.click("#work");
  await p.waitForTimeout(250);
  await expect(orb).toHaveCount(0);
  await p.click("#work");
  await p.waitForTimeout(1500);
  await expect(orb).toHaveCount(0);
  // Longer work shows it on the next poll, and it goes the moment the work ends.
  await p.click("#work");
  await expect(orb).toBeVisible({ timeout: 2500 });
  await p.click("#work");
  await expect(orb).toHaveCount(0);
  await expect(p.locator(".notch-handle .terra-mark")).toBeVisible();
});

test("a failed rating sits under the bubble, never over its text", async ({
  page: p,
}) => {
  await p.goto(`${page("open")}&markfail`);
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  const row = p.locator(".chat-row.terra").last();
  await row.hover();
  await row.getByRole("button", { name: "Useful" }).click();
  await expect(row.locator(".terra-rate-failed")).toBeVisible({
    timeout: 3000,
  });
  const bubble = await row.locator(".chat-bubble").boundingBox();
  const note = await row.locator(".terra-rate-failed").boundingBox();
  expect(note!.y).toBeGreaterThanOrEqual(bubble!.y + bubble!.height);
});

test("a source corrected after its reply appeared marks that reply, whatever the snapshot holds", async ({
  page: p,
}) => {
  await p.goto(page("open"));
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  await expect(p.locator(".chat-status")).toHaveCount(0);
  await p.click("#correct");
  // Reply 1 is past the snapshot's newest three; reply 4 is filtered out of it as invalidated.
  await expect(p.locator('[data-n="1"] .chat-status')).toBeVisible({
    timeout: 8000,
  });
  await expect(p.locator('[data-n="4"] .chat-status')).toBeVisible();
  await expect(p.locator('[data-n="2"] .chat-status')).toHaveCount(0);
});

// Scrolls so that this many px of the row show at the bottom edge of the chat.
const peekAtBottom = (p: Page, n: number, px: number) =>
  p.locator(".notch-chat").evaluate(
    (chat, { n, px }) => {
      const row = chat
        .querySelector(`[data-n="${n}"]`)!
        .getBoundingClientRect();
      chat.scrollTop += row.top - chat.getBoundingClientRect().bottom + px;
    },
    { n, px },
  );

test("a clipped reply stays unseen until most of it is in view", async ({
  page: p,
}) => {
  await p.goto(page("many"));
  await p.click("#native-enter");
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  await peekAtBottom(p, 12, 10);
  await p.waitForTimeout(2200);
  await expect(events(p)).not.toContainText("log seen 12");
  // A timer started on a mostly visible row is cancelled when the row slips out of view.
  await peekAtBottom(p, 13, 44);
  await p.waitForTimeout(500);
  await peekAtBottom(p, 13, 8);
  await p.waitForTimeout(1600);
  await expect(events(p)).not.toContainText("log seen 13");
  await p.locator('[data-n="12"]').scrollIntoViewIfNeeded();
  await expect(events(p)).toContainText("log seen 12", { timeout: 3000 });
});

test("a reply taller than the chat counts as seen once it fills the chat", async ({
  page: p,
}) => {
  await p.goto(page("open"));
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  await p.click("#tall");
  const tall = p.locator('[data-n="5"]');
  await expect(tall).toBeVisible();
  const chat = p.locator(".notch-chat");
  const view = await chat.evaluate((el) => el.clientHeight);
  expect((await tall.boundingBox())!.height).toBeGreaterThan(view);
  // It can never reach 60% of itself; scrolled into the chat, it fills the chat instead.
  await chat.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(events(p)).toContainText("log seen 5", { timeout: 3500 });
});

test("a very tall reply stops counting once it fills too little of the chat", async ({
  page: p,
}) => {
  await p.goto(page("open"));
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  await p.click("#tall");
  const tall = p.locator('[data-n="5"]');
  await expect(tall).toBeVisible();
  const chat = p.locator(".notch-chat");
  expect((await tall.boundingBox())!.height).toBeGreaterThan(1500);
  // Filling the chat starts the timer; down to 110 px of a 300 px chat must cancel it.
  await chat.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await p.waitForTimeout(500);
  await peekAtBottom(p, 5, 110);
  await p.waitForTimeout(1700);
  await expect(events(p)).not.toContainText("log seen 5");
  await chat.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(events(p)).toContainText("log seen 5", { timeout: 3000 });
});

test("a source only out of the window is marked only when no saved quote remains", async ({
  page: p,
}) => {
  await p.goto(page("open"));
  await expect(p.locator(".assistie-notch.expanded")).toBeVisible();
  await p.click("#aged");
  // Reply 1 has no saved quote; reply 2 keeps its quote, so it needs no mark.
  await expect(
    p.locator('[data-n="1"]').getByRole("img", { name: "Earlier context" }),
  ).toBeVisible({ timeout: 8000 });
  await expect(p.locator('[data-n="2"] .chat-status')).toHaveCount(0);
});

test("hiding the notch cancels a recheck in progress", async ({ page: p }) => {
  await p.goto(`${page("many")}&slowpages`);
  await expect(events(p)).toContainText("feed read after 0", { timeout: 5000 });
  await p.click("#hide");
  await p.waitForTimeout(900);
  await expect(events(p)).toContainText("notch hidden");
  const text = (await events(p).textContent()) ?? "";
  const reads = text.split("\n").filter((l) => l.includes("feed read after"));
  // The read already under way may finish; no further page is requested after the hide.
  expect(reads.length).toBeLessThanOrEqual(2);
  expect(text).not.toContain("feed read after 10");
});

test("a long answer's status clock sits beside the bubble, not on it", async ({
  page: p,
}) => {
  await p.goto(page("open"));
  await p.locator("#tall").evaluate((button: HTMLElement) => button.click());
  await p.locator("#correct").evaluate((button: HTMLElement) => button.click());
  const row = p.locator(".chat-row:has(.chat-status)").last();
  const clock = await row.locator(".chat-status").boundingBox();
  const bubble = await row.locator(".chat-bubble").boundingBox();
  expect(clock!.x).toBeGreaterThanOrEqual(bubble!.x + bubble!.width);
});

test("a long pointer wraps, the notch grows to show it, and it stays up longer", async ({
  page: p,
}) => {
  await p.goto(page("pointer"));
  const stage = p.locator("#stage");
  await expect(p.locator(".notch-line-text")).toBeVisible();
  await expect(stage).toHaveCSS("height", "80px");
  await p
    .locator("#hide")
    .evaluate((b: HTMLElement) => b.click())
    .catch(() => {});
  await p.goto(page("closed"));
  await p.locator("#tall").evaluate((b: HTMLElement) => b.click());
  const line = p.locator(".notch-line-text");
  await expect(line).toBeVisible();
  await expect(stage).toHaveCSS("height", "350px");
  const fits = await line.evaluate(
    (n) =>
      n.getBoundingClientRect().bottom <=
      n.closest("#stage")!.getBoundingClientRect().bottom,
  );
  expect(fits).toBe(true);
  const widths = await p.evaluate(() => [
    document.querySelector(".notch-measure")!.getBoundingClientRect().width,
    document.querySelector(".notch-line-text")!.getBoundingClientRect().width,
  ]);
  expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1);
  await p.waitForTimeout(6500);
  await expect(line).toBeVisible();
});
