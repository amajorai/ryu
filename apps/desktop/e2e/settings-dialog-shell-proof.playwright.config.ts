import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5237/";

export default defineConfig({
	testDir: ".",
	testMatch: /settings-dialog-shell-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.settings-dialog-shell-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
