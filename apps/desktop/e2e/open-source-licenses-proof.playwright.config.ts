import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5199/";

export default defineConfig({
	testDir: ".",
	testMatch: /open-source-licenses-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.open-source-licenses-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
