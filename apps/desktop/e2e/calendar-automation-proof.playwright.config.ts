import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5317/";

export default defineConfig({
	testDir: ".",
	testMatch: /calendar-automation-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
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
			"bunx vite --config harness/vite.calendar-automation-proof.config.ts",
		url: PROOF_URL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
