import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5247/";

export default defineConfig({
	timeout: 30_000,
	testDir: ".",
	testMatch: /plugin-settings-fields-proof\.spec\.ts$/,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		actionTimeout: 8000,
		navigationTimeout: 30_000,
		baseURL: PROOF_URL,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"bunx vite --config harness/vite.plugin-settings-fields-proof.config.ts",
		url: PROOF_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
