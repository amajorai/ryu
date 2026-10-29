import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /assistant-settings-real-proof\.spec\.ts$/,
	outputDir: `${tmpdir()}/ryu-assistant-settings-real-playwright-results`,
	workers: 1,
	timeout: 90_000,
	retries: 0,
	reporter: "list",
	use: {
		...devices["Desktop Chrome"],
		actionTimeout: 15_000,
		baseURL: "http://127.0.0.1:5420",
		trace: "off",
	},
	webServer: {
		timeout: 120_000,
		command:
			"node ../node_modules/vite/bin/vite.js --config harness/vite.assistant-settings-real-proof.config.ts",
		url: "http://127.0.0.1:5420/assistant-settings-real-proof.html",
		reuseExistingServer: true,
	},
});
