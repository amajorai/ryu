import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5299/";

export default defineConfig({
	testDir: ".",
	testMatch: /crm-record-detail-proof\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	outputDir:
		process.env.RYU_CRM_RECORD_DETAIL_TEST_RESULTS_DIR ?? "test-results",
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		timezoneId: "UTC",
		trace: "retain-on-failure",
		viewport: { width: 1440, height: 960 },
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"bunx vite --config harness/vite.crm-record-detail-proof.config.ts",
		url: PROOF_URL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
