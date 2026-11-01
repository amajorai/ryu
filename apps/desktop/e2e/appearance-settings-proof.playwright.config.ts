import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5209/";

export default defineConfig({
	testDir: ".",
	testMatch: /appearance-settings-proof(-[a-z]+)?\.spec\.ts$/,
	// One worker keeps the split specs running serially, as the single spec did.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	use: {
		acceptDownloads: true,
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.appearance-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
