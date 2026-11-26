import { expect, test, type Page } from "@playwright/test";

// Set SHOTS=/some/dir to also save each frame for side-by-side review.
const shots = process.env.SHOTS;
const URL = "/tests/main-window-preview/index.html";

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
  ["post-top", "section=postprocessing"],
  ["post-bottom", "section=postprocessing&scroll=bottom"],
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

test("nav puts content first, then settings, then About", async ({ page }) => {
  await open(page, "section=general");
  const order = await page
    .locator("nav [data-section]")
    .evaluateAll((items) => items.map((i) => i.getAttribute("data-section")));
  expect(order).toEqual([
    "calls",
    "memory",
    "history",
    "general",
    "models",
    "postprocessing",
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
