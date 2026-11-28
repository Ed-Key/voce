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
