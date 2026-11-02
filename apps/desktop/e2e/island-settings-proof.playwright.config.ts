import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5342/";

export default defineConfig({
	fullyParallel: false,
	retries: 0,
	testDir: ".",
	testMatch: /island-settings-proof\.spec\.ts$/,
	// The spec is split across files under the token limit; one worker keeps
	// them in the original order against the shared harness state.
	workers: 1,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
		viewport: { height: 900, width: 1440 },
	},
	webServer: {
		command:
			"bun run vite --config harness/vite.island-settings-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
