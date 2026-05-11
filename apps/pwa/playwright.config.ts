import { defineConfig, devices } from "@playwright/test";

// E2E tests run against a built-in stubbed API (see tests/e2e/fixtures.ts)
// so they can exercise the full Vouchflow-wired UI without a live backend.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3002",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:3002",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NEXT_PUBLIC_API_BASE: "http://127.0.0.1:3002/api/test-mock",
      NEXT_PUBLIC_VOUCHFLOW_MODE: "stub",
    },
  },
});
