import { test, expect, type Page } from "@playwright/test";

const open = async (page: Page, title = "Launch sync") => {
  await page.goto("/tests/call-observatory-preview/index.html");
  await page.getByRole("button", { name: new RegExp(title) }).click();
};
const tab = (page: Page, name: string) =>
  page.getByRole("tab", { name }).click();
const seek = (page: Page, value: number) =>
  page.locator('[data-o="scrub"]').evaluate((input: HTMLInputElement, v) => {
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);

test("notes keep the summary and show what Terra pointed out", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByText("The launch stays on Friday.")).toBeVisible();
  await expect(page.locator(".call-pointers .said")).toContainText(
    "Kenji owns the review",
  );
  await expect(page.locator(".side .call-notes")).toBeVisible();
});

test("system shows the call's real totals", async ({ page }) => {
  await open(page);
  await tab(page, "System");
  await expect(page.locator('[data-o="stat-feed"]')).toHaveText("9 lines");
  await expect(page.locator('[data-o="stat-notch"]')).toHaveText("1 shown");
  await expect(page.locator(".obs-replay .status")).toContainText(
    "9 lines · 9 Terra turns",
  );
});

test("terra keeps meeting text as text and opens a turn", async ({ page }) => {
  await open(page);
  await tab(page, "Terra");
  await expect(page.locator(".bubble")).toHaveCount(9);
  await expect(page.locator(".bubble").nth(7)).toHaveText(
    "<img src=x onerror=window.__pwned=1>",
  );
  expect(
    await page.evaluate(() => (window as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  await page.locator(".tick.overtaken").click();
  await expect(page.locator('[data-o="d-word"]')).toHaveText("Turn p2");
  await expect(page.locator('[data-o="d-verdict"]')).toContainText(
    "redone: new lines arrived",
  );
});

test("seeking while paused redraws at once, both ways", async ({ page }) => {
  await open(page);
  await tab(page, "Terra");
  await seek(page, 0);
  await expect(page.locator(".bubble")).toHaveCount(0);
  await expect(page.locator('[data-o="no-lines"]')).toBeVisible();
  await seek(page, 500);
  await expect.poll(() => page.locator(".bubble").count()).toBeGreaterThan(0);
  expect(await page.locator(".bubble").count()).toBeLessThan(9);
  await seek(page, 1000);
  await expect(page.locator(".bubble")).toHaveCount(9);
});

test("playing after a backward seek animates again", async ({ page }) => {
  await open(page);
  await tab(page, "System");
  await seek(page, 0);
  await page.locator('[data-o="play"]').click();
  await expect(page.locator('[data-o="beads"] circle').first()).toBeAttached({
    timeout: 5000,
  });
  await expect(page.locator('[data-o="stat-feed"]')).not.toHaveText("0 lines", {
    timeout: 5000,
  });
});

test("the replay picks up lines that land after Stop", async ({ page }) => {
  await open(page, "Short call");
  await tab(page, "System");
  await expect(page.locator('[data-o="stat-feed"]')).toHaveText("8 lines");
  await expect(page.locator('[data-o="stat-feed"]')).toHaveText("9 lines", {
    timeout: 8000,
  });
});

test("a live call fills in as it happens and settles after Stop", async ({
  page,
}) => {
  await open(page, "Live call");
  await tab(page, "System");
  await expect(page.locator(".obs-replay .pill")).toContainText("Live");
  await expect(page.locator('[data-o="scrub"]')).toBeHidden();
  const first = Number(
    (await page.locator('[data-o="stat-feed"]').textContent())?.split(" ")[0],
  );
  expect(first).toBeLessThan(9);
  await expect(page.locator('[data-o="stat-feed"]')).not.toHaveText(
    `${first} lines`,
    { timeout: 8000 },
  );
  await expect(page.locator(".obs-replay .dot.warn")).toHaveCount(0);
  await tab(page, "Terra");
  await page.locator(".bubble").first().click();
  await expect(page.locator(".bubble.sel")).toHaveCount(1);
  const before = await page.locator(".bubble").count();
  await expect
    .poll(() => page.locator(".bubble").count(), { timeout: 8000 })
    .toBeGreaterThan(before);
  await expect(
    page.locator(".bubble.sel"),
    "selection survives new logs",
  ).toHaveCount(1);
  await tab(page, "Transcript");
  await expect(page.locator(".call-passage").first()).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(
    page.locator(".call-passage").first(),
    "a short call keeps what was heard",
  ).toBeVisible();
  await tab(page, "System");
  await expect(page.locator(".obs-replay .pill")).toHaveCount(0);
  await expect(page.locator('[data-o="scrub"]')).toBeVisible();
});

test("Terra's small menu turns on, sets pointers, closes and restarts", async ({
  page,
}) => {
  await open(page, "Live call");
  const pill = page.locator(".terra-pill");
  await expect(pill).toHaveText("Terra off");
  await page.waitForTimeout(1200);
  const terraCalls = () =>
    page.evaluate(
      () =>
        (window as unknown as { __terraCalls?: string[] }).__terraCalls ?? [],
    );
  expect(await terraCalls()).toEqual([]);
  await pill.click();
  const terra = page.getByRole("switch", { name: "Terra for this call" });
  const pointers = page.getByRole("switch", { name: "Pointers" });
  await expect(terra).toHaveAttribute("aria-checked", "false");
  await expect(pointers).toBeDisabled();
  await expect(page.getByPlaceholder("Ask about this call")).toHaveCount(0);
  await terra.click();
  await expect(pill).toHaveText("Terra on");
  await expect(pointers).toHaveAttribute("aria-checked", "true");
  await pointers.click();
  await expect(pointers).toHaveAttribute("aria-checked", "false");
  await page.getByPlaceholder("Ask about this call").fill("When do we ship?");
  await page.getByPlaceholder("Ask about this call").press("Enter");
  await expect(page.locator(".terra-menu-answer")).toContainText("Friday");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".terra-menu")).toHaveCount(0);
  await expect(pill).toHaveText("Terra on");
  await pill.click();
  await terra.click();
  await expect(pill).toHaveText("Terra off");
  await terra.click();
  await expect(pill).toHaveText("Terra on");
  const calls = await terraCalls();
  expect(calls.filter((c) => c === "connect_terra_meeting")).toHaveLength(2);
  expect(calls).toContain("stop_assistie_fixture");
  await pill.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".terra-menu")).toHaveCount(0);
});

test("Terra's pill stays right through a slow read and a page change", async ({
  page,
}) => {
  await open(page, "Live call");
  const pill = page.locator(".terra-pill");
  await pill.click();
  const terra = page.getByRole("switch", { name: "Terra for this call" });
  await terra.click();
  await expect(pill).toHaveText("Terra on");
  await terra.click();
  await expect(pill).toHaveText("Terra off");
  await page.evaluate(() => {
    (window as unknown as { __terraSlowRead: boolean }).__terraSlowRead = true;
  });
  await page.waitForFunction(
    () => (window as unknown as { __terraReading?: boolean }).__terraReading,
  );
  await terra.click();
  await expect(pill).toHaveText("Terra on");
  await page.waitForTimeout(800);
  expect(await pill.textContent()).toBe("Terra on");
  await page.getByRole("button", { name: "Calls" }).click();
  await page.getByRole("button", { name: /Live call/ }).click();
  await expect(page.locator(".terra-pill")).toHaveText("Terra on");
  // A click before the first read lands must not restart Terra's helper.
  const connects = () =>
    page.evaluate(
      () =>
        (window as unknown as { __terraCalls: string[] }).__terraCalls.filter(
          (c) => c === "connect_terra_meeting",
        ).length,
    );
  const before = await connects();
  await page.getByRole("button", { name: "Calls" }).click();
  await page.evaluate(() => {
    (window as unknown as { __terraSlowRead: boolean }).__terraSlowRead = true;
  });
  await page.getByRole("button", { name: /Live call/ }).click();
  await page.locator(".terra-pill").click();
  await terra.click();
  await expect(page.locator(".terra-pill")).toHaveText("Terra on");
  expect(await connects()).toBe(before);
});

test("Terra's menu shows failed and revised answers", async ({ page }) => {
  await open(page, "Live call");
  await page.locator(".terra-pill").click();
  await page.getByRole("switch", { name: "Terra for this call" }).click();
  const ask = page.getByPlaceholder("Ask about this call");
  await ask.fill("Is it revised?");
  await ask.press("Enter");
  await expect(page.locator(".terra-menu-answer")).toContainText(
    "Transcript revised",
  );
  await expect(ask).toHaveValue("");
  await ask.fill("Anything missing?");
  await ask.press("Enter");
  await expect(page.getByRole("alert")).toContainText("could not answer");
  await expect(page.locator(".terra-menu-answer")).toHaveCount(0);
});

test("a Terra failure says so and stays off", async ({ page }) => {
  await open(page, "Live call");
  await page.evaluate(() => {
    (window as unknown as { __terraFail: boolean }).__terraFail = true;
  });
  await page.locator(".terra-pill").click();
  await page.getByRole("switch", { name: "Terra for this call" }).click();
  await expect(page.getByRole("alert")).toContainText("Terra could not change");
  await expect(page.locator(".terra-pill")).toHaveText("Terra off");
  await page.mouse.click(40, 500);
  await expect(page.locator(".terra-menu")).toHaveCount(0);
});

test("deleting a call asks once, then removes the row", async ({ page }) => {
  await page.goto("/tests/call-observatory-preview/index.html");
  const row = page.locator(".call-row", { hasText: "Budget check" });
  await row.hover();
  await row.getByRole("button", { name: "Delete call" }).click();
  await expect(row).toContainText("Budget check");
  await expect(row.locator(".call-row-delete")).toHaveText("Delete");
  await row.locator(".call-row-delete").click();
  await expect(
    page.locator(".call-row", { hasText: "Budget check" }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".call-row", { hasText: "Live call" })
      .locator(".call-row-delete"),
  ).toHaveCount(0);
});

test("saved Terra answers stay reachable without replay logs", async ({
  page,
}) => {
  await open(page, "Old call");
  await page.locator(".call-info summary").click();
  await expect(
    page.getByRole("button", { name: "Saved Terra answers" }),
  ).toBeVisible();
});

test("a call with no logs says so and keeps its notes", async ({ page }) => {
  await open(page, "Old call");
  await tab(page, "System");
  await expect(page.getByText("This call has no replay logs.")).toBeVisible();
  await tab(page, "Notes");
  await expect(page.getByText("The launch stays on Friday.")).toBeVisible();
});

test("with Experimental features off, call pages show no Terra", async ({
  page,
}) => {
  const off = async (title: string) => {
    await page.goto("/tests/call-observatory-preview/index.html?terraoff");
    await page.getByRole("button", { name: new RegExp(title) }).click();
  };
  await page.goto("/tests/call-observatory-preview/index.html?terraoff");
  await page.locator(".call-info summary").first().click();
  await expect(page.locator(".assistie-plugin")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Terra fictional test" }),
  ).toHaveCount(0);
  await off("Launch sync");
  await expect(page.getByRole("tab")).toHaveText(["Notes", "Transcript"]);
  await expect(page.getByText("The launch stays on Friday.")).toBeVisible();
  await expect(page.locator(".call-pointers")).toHaveCount(0);
  await page.getByRole("tab", { name: "Notes" }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Transcript" })).toBeFocused();
  await page.getByRole("tab", { name: "Transcript" }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Notes" })).toBeFocused();
  await off("Old call");
  await page.locator(".call-info summary").click();
  await expect(
    page.getByRole("button", { name: "Saved Terra answers" }),
  ).toHaveCount(0);
  await off("Live call");
  await expect(page.getByRole("tab", { name: "Notes" })).toBeVisible();
  await expect(page.locator(".terra-pill")).toHaveCount(0);
});

test("turning Experimental features off on the Terra tab shows Notes", async ({
  page,
}) => {
  await open(page);
  await tab(page, "Terra");
  await expect(page.locator(".bubble").first()).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { __setExperimental: (on: boolean) => unknown }
    ).__setExperimental(false),
  );
  await expect(page.getByRole("tab", { name: "Notes" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "Terra" })).toHaveCount(0);
  await expect(page.locator(".call-pointers")).toHaveCount(0);
});

test("speed on a real call", async ({ page }) => {
  const real = process.env.REAL_CALL_PATH;
  test.skip(
    !real,
    "set REAL_CALL_PATH to a local export to measure a real call",
  );
  await page.route("**/call-observatory-preview/real-call.json", (route) =>
    route.fulfill({ path: real! }),
  );
  await page.goto(
    "/tests/call-observatory-preview/index.html?real=real-call.json",
  );
  const started = Date.now();
  await page.getByRole("button", { name: /Launch sync/ }).click();
  await tab(page, "System");
  await expect(page.locator('[data-o="stat-feed"]')).toContainText("lines", {
    timeout: 15000,
  });
  await tab(page, "Terra");
  await expect(page.locator(".bubble").first()).toBeVisible({ timeout: 15000 });
  const firstView = Date.now() - started;
  await page.locator('[data-o="speed"]').click();
  await page.locator('[data-o="speed"]').click();
  await page.locator('[data-o="speed"]').click();
  await seek(page, 500);
  await page.locator('[data-o="play"]').click();
  const frames: number[] = await page.evaluate(
    () =>
      new Promise((done) => {
        const times: number[] = [];
        let last = performance.now();
        const step = (ms: number) => {
          times.push(ms - last);
          last = ms;
          if (times.length < 180) requestAnimationFrame(step);
          else done(times);
        };
        requestAnimationFrame(step);
      }),
  );
  const median = frames.sort((a, b) => a - b)[90];
  console.log(
    `first view ${firstView} ms, median frame ${median.toFixed(1)} ms`,
  );
  expect(firstView).toBeLessThan(1500);
  expect(median).toBeLessThan(17);
});

const memoryPage = "/tests/call-observatory-preview/index.html?memory";
const group = (page: Page, name: string) =>
  page.locator(".group", { hasText: name });

test("memory: a conflict shows both, keeping one replaces the tile", async ({
  page,
}) => {
  await page.goto(memoryPage);
  await expect(page.getByText("Terra knows this now")).toBeVisible();
  const hold = page.locator(".hold").first();
  await expect(hold).toContainText("Tuesdays");
  await expect(hold).toContainText("From Dots, 2026-10-20");
  await hold.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.getByText("Terra knows this now")).toHaveCount(0);
  await expect(group(page, "People")).toContainText("Wednesdays");
  await expect(group(page, "People")).not.toContainText("Tuesdays");
});

test("memory: a flagged entry cannot be kept until it is edited", async ({
  page,
}) => {
  await page.goto(memoryPage);
  const hold = page.locator(".hold").last();
  await expect(hold).toContainText("Has an address or link");
  await expect(hold).toContainText("date unknown");
  await expect(
    hold.getByRole("button", { name: "Keep", exact: true }),
  ).toBeDisabled();
  await hold.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("New memory entry").fill("Noor handles billing");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(group(page, "People")).toContainText("Noor handles billing");
});

test("memory: switching windows keeps a draft", async ({ page }) => {
  await page.goto(memoryPage);
  await page.getByRole("button", { name: "Add to About you" }).click();
  await page.getByLabel("New memory entry").fill("A half written thought");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(200);
  await expect(page.getByLabel("New memory entry")).toHaveValue(
    "A half written thought",
  );
});

test("memory: entries that do not fit are named", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __memoryOver: boolean }).__memoryOver = true;
  });
  await page.goto(memoryPage);
  await expect(page.getByRole("status")).toContainText("One entry doesn't fit");
  await expect(page.locator(".tile.left-out")).toContainText("Orchard");
});

test("memory: the brief opens to show what Terra gets", async ({ page }) => {
  await page.goto(memoryPage);
  await expect(page.locator(".brief")).toBeHidden();
  await page.locator("summary").click();
  await expect(page.locator(".brief")).toContainText("Orchard migration");
});

test("memory: add, edit in place, delete, and a failed save says so", async ({
  page,
}) => {
  await page.goto(memoryPage);
  const about = group(page, "About you");
  await page.getByRole("button", { name: "Add to About you" }).click();
  await page.getByLabel("New memory entry").fill("Studied in Riverton");
  await page.getByRole("button", { name: "Save" }).click();
  const value = about.getByRole("textbox", { name: "Memory entry" });
  await expect(value).toHaveText("Studied in Riverton");
  await page.evaluate(() => {
    (window as unknown as { __memoryFail: boolean }).__memoryFail = true;
  });
  await value.fill("Studied in Lakeport");
  await value.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Not saved");
  await page.evaluate(() => {
    (window as unknown as { __memoryFail: boolean }).__memoryFail = false;
    window.dispatchEvent(new Event("focus"));
  });
  // A refresh does not make the failed edit look saved.
  await expect(about.locator(".tile.left-out")).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText("Not saved");
  await value.focus();
  await value.press("Escape");
  await expect(about.locator(".tile.left-out")).toHaveCount(0);
  await expect(value).toHaveText("Studied in Riverton");
  await value.fill("Studied in Lakeport");
  await value.press("Enter");
  await expect(about.getByRole("textbox")).toHaveText("Studied in Lakeport");
  // Delete right after a half edit: the delete wins and nothing is silently dropped.
  await about.getByRole("textbox").fill("Half typed");
  await about.locator(".tile").first().hover();
  await about.getByRole("button", { name: "Delete" }).click();
  await expect(about.locator(".tile:not(.add)")).toHaveCount(0);
});
