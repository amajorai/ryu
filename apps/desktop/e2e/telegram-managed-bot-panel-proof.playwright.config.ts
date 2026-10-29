import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5477/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-telegram-managed-bot-playwright-results`,
	testDir: ".",
	testMatch: /telegram-managed-bot-panel-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	timeout: 90_000,
	use: { baseURL, ...devices["Desktop Chrome"] },
	workers: 1,
	webServer: {
		command:
			"bunx vite --config harness/vite.telegram-managed-bot-panel-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
