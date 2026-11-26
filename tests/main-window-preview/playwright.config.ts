import { defineConfig, devices } from "@playwright/test";

// The main window harness only: invented data, mocked commands, its own port.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  reporter: "line",
  use: {
    baseURL: "http://localhost:1435",
    ...devices["Desktop Chrome"],
    viewport: { width: 1180, height: 780 },
    deviceScaleFactor: 1,
    channel: "chrome",
    headless: true,
  },
  webServer: {
    command: "bunx vite dev --port 1435 --strictPort",
    cwd: "../..",
    url: "http://localhost:1435",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
