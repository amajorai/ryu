import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5186/";

export default defineConfig({
	testDir: ".",
	testMatch: /onboarding-progress-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
		viewport: { width: 1280, height: 800 },
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"bunx vite build --config harness/vite.onboarding-progress-proof.config.ts && bunx vite preview --config harness/vite.onboarding-progress-proof.config.ts --host 127.0.0.1 --port 5186 --strictPort",
		url: `${PROOF_URL}onboarding-progress-proof.html`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
