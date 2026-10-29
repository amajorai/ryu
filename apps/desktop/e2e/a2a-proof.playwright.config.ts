import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-a2a-settings-playwright-results`,
	testDir: ".",
	testMatch: /a2a-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	use: {
		baseURL: "http://127.0.0.1:5188/",
		permissions: ["clipboard-read", "clipboard-write"],
		trace: "on-first-retry",
	},
	webServer: {
		command: "bun run vite --config harness/a2a-proof.vite.config.ts",
		url: "http://127.0.0.1:5188/",
		reuseExistingServer: false,
		timeout: 120_000,
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
