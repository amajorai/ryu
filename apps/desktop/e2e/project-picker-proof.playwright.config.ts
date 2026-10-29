import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5231/";

export default defineConfig({
	testDir: ".",
	testMatch: /project-picker-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "bunx vite --config harness/vite.project-picker-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
