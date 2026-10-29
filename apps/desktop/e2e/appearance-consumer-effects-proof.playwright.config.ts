import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5527/";

export default defineConfig({
	testDir: ".",
	testMatch: /appearance-consumer-effects-proof\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	timeout: 90_000,
	retries: 0,
	use: {
		acceptDownloads: true,
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.appearance-consumer-effects-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
