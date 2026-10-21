import { defineConfig } from "@playwright/test";

const port = process.env.E2E_PORT ?? "4402";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // The smoke test walks one account through one workspace; parallel copies would only race.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "./test-results",
  use: {
    baseURL,
    // Chrome is on the GitHub runner and ordinary developer machines, so no browser download is
    // needed for the smoke test to run.
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // The API serves the built dashboard itself, so the browser only ever talks to this origin.
    command: "pnpm --filter @concord/api exec tsx test/e2e-server.ts",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { E2E_PORT: port },
  },
});
