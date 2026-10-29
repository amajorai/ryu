import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5327/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-crm-record-table-proof-results`,
	testDir: ".",
	testMatch: /crm-record-table-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		timezoneId: "UTC",
		trace: "off",
		viewport: { width: 1440, height: 960 },
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: "bunx vite --config harness/vite.crm-record-table-proof.config.ts",
		url: PROOF_URL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
