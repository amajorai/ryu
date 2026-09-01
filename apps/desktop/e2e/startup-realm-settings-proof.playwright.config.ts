import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5200/";

export default defineConfig({
	testDir: ".",
	testMatch: /startup-realm-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.startup-realm-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
