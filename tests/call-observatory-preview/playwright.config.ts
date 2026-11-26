import { defineConfig, devices } from "@playwright/test";

// The call page harness only: fictional data, mocked commands, its own port.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  reporter: "line",
  use: {
    baseURL: "http://localhost:1433",
    ...devices["Desktop Chrome"],
    viewport: { width: 1180, height: 780 },
    channel: "chrome",
    headless: true,
  },
  webServer: {
    command: "bunx vite dev --port 1433 --strictPort",
    cwd: "../..",
    url: "http://localhost:1433",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
