import { defineConfig, devices } from "@playwright/test";

// The onboarding and Cleanup settings harness
// (src/components/onboarding/preview): a fake backend, its own port.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  reporter: "line",
  use: {
    baseURL: "http://localhost:1436",
    ...devices["Desktop Chrome"],
    viewport: { width: 1180, height: 780 },
    deviceScaleFactor: 1,
    channel: "chrome",
    headless: true,
  },
  webServer: {
    command: "bunx vite dev --port 1436 --strictPort",
    cwd: "../..",
    url: "http://localhost:1436",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
