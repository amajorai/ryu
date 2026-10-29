import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5387/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-workspace-browser-panel-playwright-results`,
	testDir: ".",
	testMatch: /workspace-browser-panel-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.workspace-browser-panel-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
