import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5186/";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	outputDir: "../test-results/theme-toggle-classic",
	testDir: ".",
	testMatch: /desktop-menu-parity-proof\.spec\.ts$/,
	timeout: 120_000,
	use: {
		...devices["Desktop Chrome"],
		baseURL,
	},
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.theme-toggle-classic.config.ts",
		cwd: "..",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
	workers: 1,
});
