import { defineConfig } from "@playwright/test";
const port = Number(process.env.CONTRACTOS_TEST_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid browser test port");
const baseURL = `http://localhost:${port}`;
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  reporter: "list",
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    env: { APP_ORIGIN: baseURL },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60000,
    stdout: "ignore",
  },
});
