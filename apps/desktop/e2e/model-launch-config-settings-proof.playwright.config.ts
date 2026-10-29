import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-model-launch-config-settings-playwright-results`,
	testDir: ".",
	testMatch: /model-launch-config-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL: "http://127.0.0.1:5196/",
		trace: "on-first-retry",
	},
	webServer: {
		command:
			"bun run vite --config harness/vite.model-launch-config-settings-proof.config.ts",
		url: "http://127.0.0.1:5196/",
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
