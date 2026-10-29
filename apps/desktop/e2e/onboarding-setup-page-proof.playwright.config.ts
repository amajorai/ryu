import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5278/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-onboarding-setup-page-playwright-results`,
	testDir: ".",
	testMatch:
		/(onboarding-setup-page-proof|node-onboarding-settings-story)\.spec\.ts$/,
	fullyParallel: false,

	// The full production page imports the desktop runtime on a cold Vite start.
	timeout: 180_000,
	expect: { timeout: 30_000 },
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		navigationTimeout: 120_000,
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
			"bunx vite --config harness/vite.onboarding-setup-page-proof.config.ts --host 127.0.0.1 --port 5278 --strictPort",
		url: `${PROOF_URL}onboarding-setup-page-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
