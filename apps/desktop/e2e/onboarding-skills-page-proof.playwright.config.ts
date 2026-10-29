import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5207/";

export default defineConfig({
	testDir: ".",
	testMatch: /onboarding-skills-page-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "off",
		viewport: { height: 960, width: 1280 },
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"bunx vite --config harness/vite.onboarding-skills-page-proof.config.ts --host 127.0.0.1 --port 5207 --strictPort",
		url: `${PROOF_URL}onboarding-skills-page-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
