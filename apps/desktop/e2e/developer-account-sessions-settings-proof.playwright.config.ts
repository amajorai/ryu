import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5224/";

export default defineConfig({
	testDir: ".",
	testMatch: /developer-account-sessions-settings-proof\.spec\.ts$/,
	// The spec is split across files under the token limit; one worker keeps
	// them in the original order against the shared harness state.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.developer-account-sessions-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
