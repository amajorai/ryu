import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /assistant-panel-proof\.spec\.ts$/,
	outputDir: `${tmpdir()}/ryu-assistant-panel-playwright-results`,
	workers: 1,
	timeout: 90_000,
	retries: 0,
	reporter: "list",
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://127.0.0.1:5417",
		trace: "off",
	},
	webServer: {
		timeout: 120_000,
		command:
			"node ../node_modules/vite/bin/vite.js --config harness/vite.assistant-panel-proof.config.ts",
		url: "http://127.0.0.1:5417/assistant-panel-proof.html",
		reuseExistingServer: true,
	},
});
