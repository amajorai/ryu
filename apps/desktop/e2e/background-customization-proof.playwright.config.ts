import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5210/";

export default defineConfig({
	testDir: ".",
	testMatch: /background-customization-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		acceptDownloads: true,
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.background-customization-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
