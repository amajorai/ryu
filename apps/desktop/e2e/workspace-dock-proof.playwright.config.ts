import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5411/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-workspace-dock-playwright-results`,
	testDir: ".",
	testMatch: /workspace-dock-proof\.spec\.ts$/,
	fullyParallel: false,
	timeout: 90_000,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: {
		command:
			"node ../node_modules/vite/bin/vite.js --config harness/vite.workspace-dock-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
