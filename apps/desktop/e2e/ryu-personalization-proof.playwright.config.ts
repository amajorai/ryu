import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5185/";

export default defineConfig({
	testDir: ".",
	testMatch: /ryu-personalization-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	timeout: 120_000,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		navigationTimeout: 120_000,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"bun x vite --config harness/vite.ryu-personalization-proof.config.ts --host 127.0.0.1 --port 5185 --strictPort",
		url: `${PROOF_URL}ryu-personalization-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
