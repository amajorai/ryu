import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-advanced-inference-settings-playwright-results`,
	testDir: ".",
	testMatch: /advanced-inference-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL: "http://127.0.0.1:5197/",
		trace: "on-first-retry",
	},
	webServer: {
		command:
			"bun run vite --config harness/vite.advanced-inference-settings-proof.config.ts",
		url: "http://127.0.0.1:5197/",
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
