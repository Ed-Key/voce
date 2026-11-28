import { expect, test, type Page } from "@playwright/test";

// Set SHOTS=/some/dir to also save each frame for side-by-side review.
const shots = process.env.SHOTS;
const URL = "/tests/main-window-preview/index.html";

type Invoked = { command: string; args: Record<string, unknown> }[];
// The commands the page sent with `command`'s name (preview.tsx records them).
const invoked = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __invoked: Invoked }).__invoked.filter(
        (c) => c.command === name,
      ),
    command,
  );

async function open(page: Page, query: string) {
  await page.goto(`${URL}?${query}`);
  await page.waitForSelector("body[data-ready='1']");
  await page.evaluate(() => document.fonts.ready);
}

const FRAMES: [string, string][] = [
  ["general", "section=general"],
  ["calls", "section=calls"],
  ["history", "section=history"],
  ["models", "section=models"],
  ["advanced-top", "section=advanced"],
  ["advanced-bottom", "section=advanced&scroll=bottom"],
  ["cleanup-top", "section=cleanup"],
  ["cleanup-bottom", "section=cleanup&scroll=bottom"],
  ["about", "section=about"],
  ["general-light", "section=general&theme=light"],
  ["history-light", "section=history&theme=light"],
];

for (const [name, query] of FRAMES) {
  test(`frame ${name}`, async ({ page }) => {
    await open(page, query);
    // One page header, no footer, every settings page in the 680 px column.
    await expect(page.locator("main h1")).toHaveCount(1);
    await expect(page.getByText("Update Checking Disabled")).toHaveCount(0);
    const column = await page
      .locator("main .v-col, main .call-library")
      .first()
      .boundingBox();
    expect(Math.round(column!.width)).toBe(680);
    if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
  });
}

const nav = (page: Page) =>
  page
    .locator("nav [data-section]")
    .evaluateAll((items) => items.map((i) => i.getAttribute("data-section")));

test("nav puts content first, then settings, then About", async ({ page }) => {
  await open(page, "section=general");
  // Memory is Terra's, and Terra is experimental: hidden with the switch off (the default).
  expect(await nav(page)).toEqual([
    "calls",
    "history",
    "general",
    "models",
    "cleanup",
    "storage",
    "advanced",
    "about",
  ]);
});

test("Memory shows in the nav only with Experimental features on", async ({
  page,
}) => {
  await open(page, "section=general&experimental");
  expect(await nav(page)).toEqual([
    "calls",
    "memory",
    "history",
    "general",
    "models",
    "cleanup",
    "storage",
    "advanced",
    "about",
  ]);
});

test("history marks expired audio and drops only re-transcribe", async ({
  page,
}) => {
  await open(page, "section=history");
  await expect(page.getByText("Audio expired")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Re-transcribe" })).toHaveCount(
    3,
  );
  await expect(page.getByRole("button", { name: "Delete entry" })).toHaveCount(
    6,
  );
  // Kept entries get a player that shows the recording's length up front.
  await expect(page.getByRole("button", { name: "Play" })).toHaveCount(3);
  await expect(page.getByText("0:38")).toBeVisible();
});

test("a long history entry expands on click", async ({ page }) => {
  await open(page, "section=history");
  const text = page.getByText(/^A long ramble to check folding/);
  await text.scrollIntoViewIfNeeded();
  const folded = (await text.boundingBox())!.height;
  await text.click();
  expect((await text.boundingBox())!.height).toBeGreaterThan(folded);
});

test("auto-delete offers the 3 day choice", async ({ page }) => {
  await open(page, "section=advanced&scroll=bottom");
  await expect(
    page.getByRole("button", { name: "After 3 days" }),
  ).toBeVisible();
});

test("calls show human durations", async ({ page }) => {
  await open(page, "section=calls");
  await expect(page.getByText("1 hr 18 min")).toBeVisible();
  await expect(page.getByText("9 sec")).toBeVisible();
});

test("keyboard activation of a nav entry moves the highlight with the page", async ({
  page,
}) => {
  await open(page, "section=general");
  const cleanup = page.locator('nav [data-section="cleanup"]');
  await cleanup.focus();
  await page.keyboard.press("Enter");
  await expect(cleanup).toHaveAttribute("aria-current", "page");
  await expect(
    page.locator('nav [data-section="general"]'),
  ).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator(".v-ph h1").first()).toHaveText("Cleanup");
  await page.locator('nav [data-section="storage"]').focus();
  await page.keyboard.press("Space");
  await expect(page.locator('nav [data-section="storage"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
});

// Review finding 2 (onboarding row 24): this fixture is a user migrated past onboarding (done, no
// screen_names stored), so names on screen are on; Settings > Advanced can turn them off.
test("a migrated user can turn off reading names on screen", async ({
  page,
}) => {
  await open(page, "section=advanced");
  const names = page.getByRole("switch", { name: "Read names on screen" });
  await expect(names).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByText("Skips password fields. What it reads stays on your Mac."),
  ).toBeVisible();
  await names.click();
  await expect
    .poll(async () => await invoked(page, "change_screen_names_setting"))
    .toEqual([
      { command: "change_screen_names_setting", args: { enabled: false } },
    ]);
  await expect(names).toHaveAttribute("aria-checked", "false");
});

// Review finding 3 (row C4): with no server detected and none saved, Settings > Cleanup still offers a
// custom server whose address and model are typed under Advanced.
test("a custom cleanup server can be set up with none detected", async ({
  page,
}) => {
  await open(page, "section=cleanup&provider=voce_local");
  await page.getByRole("radio", { name: /Custom server/ }).click();
  const url = page.getByRole("textbox", { name: "Base URL" });
  await url.fill("http://127.0.0.1:8080/v1");
  await url.blur();
  const model = page.getByRole("textbox", { name: "Model name" });
  await model.fill("my-model");
  await model.blur();
  await expect
    .poll(async () =>
      (await invoked(page, "test_cleanup")).map((c) => c.args.choice),
    )
    .toContainEqual({
      kind: "local_server",
      base_url: "http://127.0.0.1:8080/v1",
      model: "my-model",
    });
});

// Review finding 4 (row 16): Apple Intelligence is offered whenever this Mac supports it; switching to
// it saves, and reopening the page shows it chosen.
test("switching to Apple Intelligence saves and survives reopening", async ({
  page,
}) => {
  await open(page, "section=cleanup");
  const apple = page.getByRole("radio", { name: /Apple Intelligence/ });
  await apple.click();
  await expect
    .poll(async () => (await invoked(page, "save_cleanup_choice")).length)
    .toBe(1);
  await page.locator('nav [data-section="general"]').click();
  await page.locator('nav [data-section="cleanup"]').click();
  await expect(apple).toHaveAttribute("aria-checked", "true");
});

// Second review, finding 3 (row C5): on an eligible Mac whose model is still downloading, Apple Intelligence
// is offered with what is missing; picking it tests nothing until it is ready, and the page notices
// readiness while it stays open, then tests and saves.
test("Apple Intelligence on an eligible Mac waits until it is ready", async ({
  page,
}) => {
  await open(page, "section=cleanup&apple=model_not_ready");
  const apple = page.getByRole("radio", { name: /Apple Intelligence/ });
  await expect(apple).toContainText(
    "Apple Intelligence is still downloading its model.",
  );
  await apple.click();
  await expect(page.getByText("Waiting for Apple Intelligence")).toBeVisible();
  const appleTests = async () =>
    (await invoked(page, "test_cleanup")).filter(
      (c) => (c.args.choice as { kind: string }).kind === "apple_intelligence",
    ).length;
  await page.waitForTimeout(500);
  expect(await appleTests()).toBe(0);
  expect(await invoked(page, "save_cleanup_choice")).toHaveLength(0);
  await page.evaluate(() => {
    (
      window as unknown as { __replies: Record<string, unknown> }
    ).__replies.apple_intelligence_state = "ready";
  });
  await expect.poll(appleTests, { timeout: 8000 }).toBe(1);
  await expect
    .poll(async () => (await invoked(page, "save_cleanup_choice")).length)
    .toBe(1);
});

test("Apple Intelligence is not offered on a Mac that cannot run it", async ({
  page,
}) => {
  await open(page, "section=cleanup&apple=unsupported");
  await expect(
    page.getByRole("radio", { name: /Custom server|LM Studio/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: /Apple Intelligence/ }),
  ).toHaveCount(0);
});

// Third review, finding 2 (row C5): the native close only hides the window, so the readiness check and the
// chooser pause while hidden and pick up again when it shows; leaving the page stops them too.
test("Cleanup pauses its readiness checks while the window is hidden", async ({
  page,
}) => {
  await open(page, "section=cleanup&apple=model_not_ready");
  const checks = async () =>
    (await invoked(page, "apple_intelligence_state")).length;
  const appleTests = async () =>
    (await invoked(page, "test_cleanup")).filter(
      (c) => (c.args.choice as { kind: string }).kind === "apple_intelligence",
    ).length;
  await page.getByRole("radio", { name: /Apple Intelligence/ }).click();
  await expect.poll(checks, { timeout: 8000 }).toBeGreaterThan(1);
  // Closed with the native button; Apple Intelligence gets ready meanwhile.
  await page.evaluate(async () => {
    const w = window as unknown as {
      __emit: (event: string) => Promise<void>;
      __replies: Record<string, unknown>;
    };
    await w.__emit("main-window-hidden");
    w.__replies.apple_intelligence_state = "ready";
  });
  const hidden = await checks();
  await page.waitForTimeout(4000);
  expect(await checks()).toBe(hidden);
  expect(await appleTests()).toBe(0);
  expect(await invoked(page, "save_cleanup_choice")).toHaveLength(0);
  // Shown again: it checks at once, then tests and saves.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(appleTests, { timeout: 2000 }).toBe(1);
  await expect
    .poll(async () => (await invoked(page, "save_cleanup_choice")).length)
    .toBe(1);
});

test("leaving Cleanup stops its readiness checks", async ({ page }) => {
  await open(page, "section=cleanup&apple=model_not_ready");
  const checks = async () =>
    (await invoked(page, "apple_intelligence_state")).length;
  await page.locator('nav [data-section="general"]').click();
  const left = await checks();
  await page.waitForTimeout(4000);
  expect(await checks()).toBe(left);
});

// Third review, finding 3 (row C5): a saved Apple Intelligence on a Mac that cannot run it is not offered,
// stays saved (nothing replaces it), and the page says so.
test("a saved Apple Intelligence on an unsupported Mac is kept and explained", async ({
  page,
}) => {
  await open(
    page,
    "section=cleanup&provider=apple_intelligence&apple=unsupported",
  );
  await expect(
    page.getByText(
      "Your saved choice, Apple Intelligence, isn't available on this Mac.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: /Apple Intelligence/ }),
  ).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await invoked(page, "test_cleanup")).toHaveLength(0);
  expect(await invoked(page, "save_cleanup_choice")).toHaveLength(0);
  expect(await invoked(page, "turn_cleanup_off")).toHaveLength(0);
});
