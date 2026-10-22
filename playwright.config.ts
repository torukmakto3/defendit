import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${port}`;

/**
 * Mock-mode browser tests. The server is started with MOCK_LLM=1 and no
 * provider keys are required. Faults are injected in the tests by intercepting
 * requests; this config does not change production behaviour.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/keys`,
    reuseExistingServer: process.env.E2E_REUSE === "1",
    timeout: 240_000,
    env: {
      MOCK_LLM: "1",
      MOCK_GRADER_DELAY_MS: "2000",
      APP_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      DATABASE_PATH: "data/e2e.db",
      // `next start` is NODE_ENV=production, which otherwise hides dev sign-in
      // links and refuses to boot without deployment keys. These are fixtures.
      AUTH_DEV_LINKS: "1",
      DEFEND_IT_SIGNING_SEED: "33".repeat(32),
      DATA_ENCRYPTION_KEY: "22".repeat(32),
      // Production refuses to boot without a 64-hex HMAC key for IP hashes.
      IP_HASH_SALT: "11".repeat(32),
      DATABASE_URL: "",
      // Challenge pages 404 unless this is on. One free defense per account
      // makes the out-of-credits screen a second start, after the first receipt.
      CHALLENGES_ENABLED: "1",
      BETA_DEFENSE_CREDITS: "1",
      // Sample path is off unless this is exactly 1 or true. `next start` is
      // production, so the IP salt has to be present or a demo start returns 503.
      DEMO_ENABLED: "1",
      DEMO_IP_SALT: "ab".repeat(32),
    },
  },
});
