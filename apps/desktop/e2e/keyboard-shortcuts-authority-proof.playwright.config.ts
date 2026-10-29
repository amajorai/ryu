import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5208/";

export default defineConfig({
	testDir: ".",
	testMatch: /keyboard-shortcuts-authority-proof\.spec\.ts$/,
	fullyParallel: false,
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
			"bunx vite --config harness/vite.keyboard-shortcuts-authority-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
