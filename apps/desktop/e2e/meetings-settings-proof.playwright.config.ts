import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5573/";

export default defineConfig({
	outputDir: "/tmp/ryu-meetings-settings-proof-results",
	testDir: ".",
	testMatch: /meetings-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	timeout: 60_000,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1360, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.meetings-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
