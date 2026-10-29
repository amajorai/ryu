import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5395/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-panel-tab-bar-playwright-results`,
	testDir: ".",
	testMatch: /panel-tab-bar-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: { baseURL, ...devices["Desktop Chrome"] },
	webServer: {
		command: "bunx vite --config harness/vite.panel-tab-bar-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: `${baseURL}panel-tab-bar-proof.html`,
	},
});
