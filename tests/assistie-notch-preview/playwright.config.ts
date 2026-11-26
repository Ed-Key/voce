import { defineConfig, devices } from "@playwright/test";

// The notch harness only: fictional data, mocked commands, its own port so it never reuses the app's dev server.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  reporter: "line",
  use: {
    baseURL: "http://localhost:1431",
    ...devices["Desktop Chrome"],
    channel: "chrome",
    headless: true,
  },
  webServer: {
    command: "bunx vite dev --port 1431 --strictPort",
    cwd: "../..",
    url: "http://localhost:1431",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
