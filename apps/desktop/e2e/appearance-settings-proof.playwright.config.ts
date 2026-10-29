import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5209/";

export default defineConfig({
	testDir: ".",
	testMatch: /appearance-settings-proof\.spec\.ts$/,
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
