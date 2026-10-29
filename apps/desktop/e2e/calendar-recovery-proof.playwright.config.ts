import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5392/";

export default defineConfig({
	testDir: ".",
	testMatch: /calendar-recovery-proof\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	outputDir:
		"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-gateway/evidence/calendar-recovery-results",
	retries: 0,
	reporter: [
		["list"],
		[
			"json",
			{
				outputFile:
					"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-gateway/evidence/calendar-recovery-results.json",
			},
		],
	],
	use: {
		baseURL: PROOF_URL,
		trace: "off",
		viewport: { width: 1280, height: 1000 },
		timezoneId: "UTC",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"bunx vite --config harness/vite.calendar-recovery-proof.config.ts",
		url: PROOF_URL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
