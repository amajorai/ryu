import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5268/";

export default defineConfig({
	testDir: ".",
	testMatch: /approvals-behavior-proof\.spec\.ts$/,
	globalSetup: "./harness/approvals-behavior-proof.global-setup.ts",
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "line",
	use: {
		baseURL,
		viewport: { width: 1280, height: 1600 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.approvals-behavior-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
