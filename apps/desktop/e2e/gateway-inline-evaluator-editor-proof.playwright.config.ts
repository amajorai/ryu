import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5341/";

export default defineConfig({
	fullyParallel: false,
	retries: 0,
	testDir: ".",
	testMatch: /gateway-inline-evaluator-editor-proof\.spec\.ts$/,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { height: 900, width: 1440 },
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-inline-evaluator-editor-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
