import { expect, test, type Page } from "@playwright/test";

// Behaviour of the onboarding steps and Settings > Cleanup against the
// preview's fake backend. window.__calls lists what the fake backend was
// asked (tests and saves), window.__ipc every Tauri command the page sent.
const URL = "/src/components/onboarding/preview/index.html";

async function open(page: Page, query: string) {
  await page.goto(`${URL}?theme=dark&${query}`);
  await page.waitForTimeout(600);
}
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: string[] }).__calls);
const ipc = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __ipc: string[] }).__ipc.join(" | "),
  );
type Choice = Record<string, string>;
const tests = async (page: Page) =>
  (await calls(page))
    .filter((c) => c.startsWith("test "))
    .map((c) => JSON.parse(c.slice(5)) as Choice);
// Start recording new keys from the keyboard (Enter on the key caps), the
// way a keyboard user would.
async function rebind(page: Page) {
  await page.locator(".rebind .v-keys").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
}
const status = (page: Page) => page.locator(".test .top .st").innerText();
const tryEvent = (page: Page, e: object) =>
  page.evaluate(
    (e) => (window as unknown as { __try: (e: object) => void }).__try(e),
    e,
  );

test.describe("onboarding cleanup", () => {
  test("a late result is ignored after switching option (row 16b)", async ({
    page,
  }) => {
    await open(page, "step=cleanup&state=slow");
    await page.locator(".opt:has-text('LM Studio')").click();
    await page.waitForTimeout(2000);
    expect(await status(page)).toContain("0.9");
  });

  test("Off stays off when a late result arrives", async ({ page }) => {
    await open(page, "step=cleanup&state=slow");
    await page.locator(".opt:has-text('Paste exactly')").click();
    await page.waitForTimeout(1800);
    expect(await status(page)).toContain("No cleanup");
    await expect(page.locator(".foot .v-primary")).toBeEnabled();
  });

  test("Continue waits for the test", async ({ page }) => {
    await open(page, "step=cleanup&state=s1-testing");
    await expect(page.locator(".foot .v-primary")).toBeDisabled();
    await expect(page.locator(".foot >> text=Set up later")).toBeVisible();
  });

  test("a cloud test names a model on a fresh install (review 4)", async ({
    page,
  }) => {
    await open(page, "step=cleanup&state=cloud");
    await page.locator(".opt:has-text('Cloud service')").click();
    await page.fill("input.v-field", "sk-openai-key-1234567890");
    await page.waitForTimeout(1200);
    const cloud = (await tests(page)).filter((t) => t.kind === "cloud");
    expect(cloud.length).toBeGreaterThan(0);
    for (const t of cloud) expect(t.model).not.toBe("");
  });

  test("a typed key lists the provider's models and tests a real one", async ({
    page,
  }) => {
    await open(page, "step=cleanup&state=models");
    await page.locator(".opt:has-text('Cloud service')").click();
    await page.fill("input.v-field", "sk-openai-key-1234567890");
    await page.waitForTimeout(1800);
    const cloud = (await tests(page)).filter((t) => t.kind === "cloud");
    // One test, on the preselected model from the real list.
    expect(cloud.map((t) => t.model)).toEqual(["gpt-4.1-mini"]);
    await expect(page.locator(".fields .v-sel")).toHaveCount(2);
    await page.locator(".fields .v-sel").first().click();
    await page.locator(".v-menu button:has-text('Anthropic')").click();
    await page.fill("input.v-field", "sk-ant-key-1234567890");
    await page.waitForTimeout(1800);
    const ant = (await tests(page)).filter((t) => t.provider === "anthropic");
    expect(ant.map((t) => t.model)).toEqual(["claude-haiku-9"]);
  });

  test("a key only goes to the provider it was typed for (review 2)", async ({
    page,
  }) => {
    await open(page, "step=cleanup&state=cloud");
    await page.locator(".opt:has-text('Cloud service')").click();
    await page.fill("input.v-field", "sk-openai-key-1234567890");
    await page.waitForTimeout(1200);
    await page.locator(".fields .v-sel").first().click();
    await page.locator(".v-menu button:has-text('Anthropic')").click();
    await page.waitForTimeout(1200);
    const sent = (await tests(page)).filter((t) => t.provider === "anthropic");
    for (const t of sent) expect(t.apiKey).not.toBe("sk-openai-key-1234567890");
  });
});

test.describe("onboarding flow", () => {
  test("steps forward and back", async ({ page }) => {
    await open(page, "step=welcome&state=granted");
    await page.click("text=Get started");
    await expect(page.locator("h1")).toHaveText("Allow two things");
    await page.click(".foot .v-primary");
    await expect(page.locator("h1")).toContainText("speech model");
    await page.click(".foot >> text=Back");
    await expect(page.locator("h1")).toHaveText("Allow two things");
  });

  test("a pending speech download resumes at a later step (review 11)", async ({
    page,
  }) => {
    await open(page, "step=cleanup&state=stopped");
    expect(await ipc(page)).toContain('download_model {"modelId":"p-unified"}');
  });

  test("Try it: practice text lands in the box, nothing pastes (review 5)", async ({
    page,
  }) => {
    await open(page, "step=try&state=ready");
    await tryEvent(page, { type: "recording" });
    await tryEvent(page, { type: "transcribing" });
    await tryEvent(page, { type: "text", text: "Hello from practice." });
    await tryEvent(page, { type: "finished" });
    await expect(page.locator("h1")).toContainText("all there is");
    await expect(page.locator("textarea")).toHaveValue("Hello from practice.");
  });

  test("Try it: no text after the overlay closes says so", async ({ page }) => {
    await open(page, "step=try&state=ready");
    await tryEvent(page, { type: "recording" });
    await tryEvent(page, { type: "transcribing" });
    await tryEvent(page, { type: "finished" });
    await expect(page.locator(".trouble")).toContainText("went wrong", {
      timeout: 7000,
    });
  });

  test("Try it: a taken shortcut is named, with a way to change it (review 12)", async ({
    page,
  }) => {
    await open(page, "step=try&state=taken");
    await expect(page.locator(".trouble")).toContainText(
      "Option + Space is used by another app",
    );
    await expect(page.locator(".rebind .v-keys")).toBeVisible();
  });

  test("Try it: rebinding clears the warning, then shows the next one (review N5)", async ({
    page,
  }) => {
    await open(page, "step=try&state=taken2");
    const warn = page.locator(".trouble");
    await expect(warn).toContainText("Option + Space is used");
    await rebind(page);
    await page.keyboard.down("Control");
    await page.keyboard.press("k");
    await page.keyboard.up("Control");
    await expect(warn).toContainText("Option + Shift + Space is used", {
      timeout: 3000,
    });
    // By mouse: the starting click must not cancel the recording.
    await page.locator(".rebind .v-keys").click();
    await page.waitForTimeout(200);
    await page.keyboard.down("Control");
    await page.keyboard.press("j");
    await page.keyboard.up("Control");
    await expect(warn).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator(".rebind")).toHaveCount(0);
    // Coming back to the window re-reads registration (suspend, change,
    // resume, refocus): the working keys are not reported as taken again.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(300);
    await expect(warn).toHaveCount(0);
    expect(await ipc(page)).toMatch(
      /suspend_all_bindings.*change_binding.*resume_all_bindings/,
    );
  });

  test("Try it: practice starts again when the window is shown (review N3)", async ({
    page,
  }) => {
    await open(page, "step=try&state=ready");
    const starts = async () =>
      (await calls(page)).filter((c) => c === "start").length;
    const before = await starts();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(200);
    expect(await starts()).toBe(before + 1);
  });

  test("Try it: the time from release to text never reads zero", async ({
    page,
  }) => {
    await open(page, "step=try&state=ready");
    await tryEvent(page, { type: "recording" });
    await tryEvent(page, { type: "transcribing" });
    await page.waitForTimeout(150);
    await tryEvent(page, { type: "text", text: "Hi." });
    await expect(page.locator(".after .ok")).toHaveText(/Ready in [1-9]\d* ms/);
  });

  test("Try it: leaving ends practice mode", async ({ page }) => {
    await open(page, "step=try&state=ready");
    await page.click(".foot >> text=Back");
    await page.waitForTimeout(200);
    expect((await calls(page)).join(" ")).toContain("stop");
  });

  test("Try it: the practice box text finishes the step", async ({ page }) => {
    await open(page, "step=try&state=ready");
    await tryEvent(page, { type: "recording" });
    await tryEvent(page, { type: "transcribing" });
    await page.fill("textarea", "Hello there.");
    await expect(page.locator("h1")).toContainText("all there is");
  });

  test("Storage: trash only where removable, confirm closes on Escape", async ({
    page,
  }) => {
    await open(page, "step=storage&state=onboarding");
    await expect(page.locator(".ac .v-ib[aria-label]")).toHaveCount(5);
    await page.locator(".v-ib[aria-label='Delete']").click();
    await expect(page.locator(".pop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".pop")).toHaveCount(0);
  });

  test("Names: reduced motion holds one frame", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "step=names");
    const a = await page.screenshot();
    await page.waitForTimeout(1200);
    expect(Buffer.compare(a, await page.screenshot())).toBe(0);
  });
});

test.describe("Settings > Cleanup", () => {
  const S = "step=cleanup-settings";

  test("opening the page saves nothing", async ({ page }) => {
    await open(page, `${S}&state=default`);
    await page.waitForTimeout(400);
    expect(await status(page)).toContain("0.4");
    expect((await calls(page)).join(" ")).not.toContain("save");
    await expect(page.locator(".opt:has-text('Paste exactly')")).toHaveCount(0);
  });

  test("a new model is saved by its passed test's id", async ({ page }) => {
    await open(page, `${S}&state=default`);
    await page.locator(".opt:has-text('LM Studio')").click();
    await page.waitForTimeout(500);
    expect((await calls(page)).join(" | ")).toMatch(/save local \d+/);
    await expect(page.locator("p.why")).toBeVisible();
  });

  test("Clean while you talk is disabled for cloud, with a reason", async ({
    page,
  }) => {
    await open(page, `${S}&state=default`);
    await page.locator(".opt:has-text('Cloud service')").click();
    await expect(page.locator("[role=switch]").nth(1)).toBeDisabled();
    await expect(page.locator("text=not cloud services")).toBeVisible();
  });

  test("switch off, and on again through the test", async ({ page }) => {
    await open(page, `${S}&state=default`);
    await page.locator("[role=switch]").first().click();
    await page.waitForTimeout(300);
    expect((await calls(page)).join(" ")).toContain("save off");
    await open(page, `${S}&state=off`);
    expect(await status(page)).toContain("No cleanup");
    await page.locator("[role=switch]").first().click();
    await page.waitForTimeout(800);
    expect((await calls(page)).join(" | ")).toMatch(/save s1 \d+/);
  });

  test("style is saved and previewed", async ({ page }) => {
    await open(page, `${S}&state=default`);
    await page.click(".seg button:has-text('Casual')");
    await page.click(".seg button:has-text('Lists')");
    await page.waitForTimeout(300);
    expect((await calls(page)).join(" ")).toContain("s1 casual lists general");
    await expect(page.locator(".prev .txt li")).toHaveCount(3);
  });

  test("Apple Intelligence stays the choice and nothing is saved (review 3)", async ({
    page,
  }) => {
    await open(page, `${S}&state=apple`);
    await page.waitForTimeout(600);
    await expect(page.locator(".opt.sel")).toContainText("Apple Intelligence");
    expect((await calls(page)).join(" ")).not.toContain("save");
    expect((await tests(page)).some((t) => t.kind === "s1")).toBe(false);
  });

  test("an edited base URL drives the next test (review 9)", async ({
    page,
  }) => {
    await open(page, `${S}&state=advanced`);
    await page.click(".fold");
    const url = page.locator("input.v-field").first();
    await url.fill("http://localhost:9999/v1");
    await url.evaluate((e: HTMLElement) => e.blur());
    await page.waitForTimeout(800);
    const all = await tests(page);
    expect(all[all.length - 1].baseUrl).toBe("http://localhost:9999/v1");
  });

  test("custom instructions edit the selected prompt (review 10)", async ({
    page,
  }) => {
    await open(page, `${S}&state=prompt`);
    await page.click(".fold");
    const box = page.locator("textarea.v-field");
    await expect(box).toHaveValue("My own selected prompt.");
    await box.fill("Edited.");
    await box.evaluate((e: HTMLElement) => e.blur());
    await page.waitForTimeout(300);
    expect(await ipc(page)).toContain(
      'update_post_process_prompt {"id":"mine"',
    );
  });

  test("a new model for a saved cloud key is saved after its test (review N4)", async ({
    page,
  }) => {
    await open(page, `${S}&state=cloudsaved`);
    await page.waitForTimeout(1500);
    // Opening runs the saved choice's test and saves nothing.
    expect((await tests(page)).map((t) => t.model)).toEqual(["gpt-4.1"]);
    expect((await calls(page)).some((c) => c.startsWith("save "))).toBe(false);
    await page.locator(".fields .v-sel").nth(1).click();
    await page.locator(".v-menu button:has-text('gpt-4o')").click();
    await page.waitForTimeout(600);
    const all = await tests(page);
    expect(all[all.length - 1].model).toBe("gpt-4o");
    expect((await calls(page)).join(" | ")).toMatch(/save cloud \d+/);
  });

  test("the key is never on the page", async ({ page }) => {
    await open(page, `${S}&state=advanced`);
    await page.click(".fold");
    await expect(page.locator("text=Saved in Keychain")).toBeVisible();
    expect(await page.content()).not.toContain("stored");
  });
});

test.describe("found in the test app", () => {
  test("Settings > Cleanup shows the saved state, not a stale one (bugs 1, 2)", async ({
    page,
  }) => {
    await open(page, "step=cleanup-settings&state=stale");
    await page.waitForTimeout(1600);
    await expect(page.locator("[role=switch]").first()).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator(".opt.sel")).toContainText("Voce cleanup");
    await expect(page.locator("[role=switch]").nth(1)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(await status(page)).toContain("Passed");
  });

  test("the model footer ignores the cleanup model's download (bug 3)", async ({
    page,
  }) => {
    await open(page, "step=cleanup-settings&state=default");
    await page.evaluate(() =>
      (
        window as unknown as { __emit: (e: string, p: object) => Promise<void> }
      ).__emit("model-download-progress", {
        model_id: "voce-cleanup-s1-mini",
        downloaded: 100,
        total: 100,
        percentage: 100,
      }),
    );
    await page.waitForTimeout(300);
    await expect(page.locator("aside")).not.toContainText("Downloading");
  });

  test("only words the output dropped are greyed (bug 5)", async ({ page }) => {
    await open(page, "step=cleanup&state=keepfillers");
    await page.waitForTimeout(400);
    expect(await page.locator(".said s").allInnerTexts()).toEqual([
      "um",
      "uh",
      "the",
    ]);
  });

  test("the collapsed model list holds only the shown rows (bug 6)", async ({
    page,
  }) => {
    await open(page, "step=speech&state=manycached");
    expect(await page.locator(".opt").count()).toBeLessThanOrEqual(3);
  });

  test("Welcome names all six steps (bug 7)", async ({ page }) => {
    await open(page, "step=welcome");
    await expect(page.locator(".next > div")).toHaveCount(6);
  });

  test("a slow first test says the server is starting, then shows the cleanup's own time (bug 4)", async ({
    page,
  }) => {
    await open(page, "step=cleanup&state=coldstart");
    const st = page.locator(".test .top .st");
    await expect(st).toContainText("Starting cleanup on this Mac", {
      timeout: 2400,
    });
    await expect(st).toContainText("Passed in 0.3 s", { timeout: 4000 });
  });

  test("Voce cleanup downloads from the Speech step, and is warmed at Cleanup", async ({
    page,
  }) => {
    await open(page, "step=speech&state=choose&s1=missing");
    expect(await calls(page)).toContain("downloadS1");
    await open(page, "step=cleanup&state=s1-passed");
    expect(await calls(page)).toContain("warm");
  });
});

test.describe("the background s1-mini download (review 3, finding 2)", () => {
  const count = async (page: Page, c: string) =>
    (await calls(page)).filter((x) => x === c).length;

  test("Back keeps it going, and returning starts no second one", async ({
    page,
  }) => {
    await open(page, "step=speech&state=granted&s1=missing");
    expect(await count(page, "downloadS1")).toBe(1);
    await page.click(".foot >> text=Back");
    await page.waitForTimeout(200);
    expect(await count(page, "cancelS1")).toBe(0);
    await page.click(".foot .v-primary"); // Permissions: Continue
    await page.waitForTimeout(400);
    expect(await count(page, "downloadS1")).toBe(1);
  });

  test("not started when another cleanup was saved", async ({ page }) => {
    await open(page, "step=speech&state=savedother&s1=missing&saved=try");
    expect(await count(page, "downloadS1")).toBe(0);
  });

  test("resumed at Cleanup, rejected, Back to Speech: no new download (review 4, finding 3)", async ({
    page,
  }) => {
    await open(page, "step=cleanup&state=fresh&s1=missing");
    await page.locator(".opt:has-text('Paste exactly')").click();
    await page.waitForTimeout(200);
    await page.click(".foot >> text=Back");
    await page.waitForTimeout(600);
    await expect(page.locator("h1")).toContainText("speech model");
    expect(await count(page, "cancelS1")).toBe(1);
    // At most the one Cleanup itself started before the user said no.
    expect(await count(page, "downloadS1")).toBeLessThanOrEqual(1);
    const after = (await calls(page)).slice(
      (await calls(page)).indexOf("cancelS1"),
    );
    expect(after).not.toContain("downloadS1");
  });

  test("a rejection while the start check is pending wins (review 4, finding 3)", async ({
    page,
  }) => {
    await open(page, "step=speech&state=downloading&s1=missing&slowcheck=1");
    await page.click(".foot .v-primary"); // Continue while the check runs
    await page.locator(".opt:has-text('Paste exactly')").click();
    await page.waitForTimeout(2500);
    expect(await count(page, "downloadS1")).toBe(0);
  });

  for (const [what, act] of [
    ["Off", (p: Page) => p.locator(".opt:has-text('Paste exactly')").click()],
    [
      "another option",
      (p: Page) => p.locator(".opt:has-text('LM Studio')").click(),
    ],
    ["Set up later", (p: Page) => p.click(".foot >> text=Set up later")],
  ] as const) {
    test(`picking ${what} stops it`, async ({ page }) => {
      await open(page, "step=cleanup&state=s1-downloading");
      await act(page);
      await page.waitForTimeout(300);
      expect(await count(page, "cancelS1")).toBe(1);
    });
  }
});

test.describe("found in the second walk", () => {
  test("every storage detail is text, never a key", async ({ page }) => {
    await open(page, "step=storage&state=onboarding");
    const details = await page.locator(".list .nm small").allInnerTexts();
    expect(details.length).toBeGreaterThan(5);
    for (const d of details) expect(d).not.toMatch(/storage\.|items\./);
    expect(details).toContain("Last 3 days");
    await expect(page.locator(".hd p")).toHaveText(
      "You can find this later in Settings.",
    );
  });

  test("no trash icon on a row with nothing in it", async ({ page }) => {
    await open(page, "step=storage&state=empty");
    for (const name of ["Saved recordings", "History"]) {
      const row = page.locator(".list .v-row", { hasText: name });
      await expect(row.locator(".v-ib")).toHaveCount(0);
    }
  });
});
