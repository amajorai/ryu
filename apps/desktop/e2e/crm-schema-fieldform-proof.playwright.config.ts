import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5333/";

export default defineConfig({
	testDir: ".",
	outputDir:
		process.env.RYU_CRM_SCHEMA_FIELDFORM_TEST_RESULTS_DIR ??
		`${tmpdir()}/ryu-crm-schema-fieldform-proof-results`,
	testMatch: /crm-schema-fieldform-proof\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
		viewport: { width: 1280, height: 900 },
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"bunx vite --config harness/vite.crm-schema-fieldform-proof.config.ts",
		url: PROOF_URL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
