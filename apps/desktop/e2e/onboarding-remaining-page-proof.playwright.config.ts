import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5297/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-onboarding-remaining-page-playwright-results`,
	testDir: ".",
	testMatch: /onboarding-remaining-page-proof\.spec\.ts$/,
	fullyParallel: false,

	// The full production page imports the desktop runtime on a cold Vite start.
	timeout: 180_000,
	expect: { timeout: 30_000 },
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		navigationTimeout: 120_000,
		actionTimeout: 30_000,
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
			"bunx vite --config harness/vite.onboarding-remaining-page-proof.config.ts --host 127.0.0.1 --port 5297 --strictPort",
		url: `${PROOF_URL}onboarding-remaining-page-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
