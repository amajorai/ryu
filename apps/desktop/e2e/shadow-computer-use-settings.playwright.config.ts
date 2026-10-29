import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5228";

export default defineConfig({
	testDir: ".",
	testMatch: /shadow-computer-use-settings\.spec\.ts$/,
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	retries: 0,
	reporter: "list",
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		trace: "retain-on-failure",
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.shadow-computer-use-proof.config.ts",
		url: `${baseURL}/shadow-computer-use-proof.html`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
