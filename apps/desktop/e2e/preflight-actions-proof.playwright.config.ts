import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	outputDir: "test-results/preflight-actions-proof",
	testMatch: /preflight-actions-proof\.spec\.ts$/,
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	retries: 0,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5217",
		...devices["Desktop Chrome"],
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.preflight-actions-proof.config.ts",
		url: "http://127.0.0.1:5217/preflight-actions-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
