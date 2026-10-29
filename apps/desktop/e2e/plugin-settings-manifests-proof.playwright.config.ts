import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5359/";

export default defineConfig({
	timeout: 180_000,
	testDir: ".",
	testMatch: /plugin-settings-manifests-proof\.spec\.ts$/,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	expect: { timeout: 15_000 },
	reporter: process.env.CI ? "github" : "list",
	use: {
		actionTimeout: 30_000,
		navigationTimeout: 60_000,
		baseURL: PROOF_URL,
		trace: "off",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"bunx vite --config harness/vite.plugin-settings-manifests-proof.config.ts",
		url: PROOF_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
