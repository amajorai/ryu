import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /bot-managed-entry-proof\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	outputDir: "test-results/bot-managed-entry-proof",
	use: {
		baseURL: "http://127.0.0.1:5494",
		viewport: { width: 900, height: 650 },
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	webServer: {
		command:
			"bunx vite --config harness/vite.bot-managed-entry-proof.config.ts",
		url: "http://127.0.0.1:5494/bot-managed-entry-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
