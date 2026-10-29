import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5182/";

export default defineConfig({
	testDir: ".",
	testMatch: /voice-island-mode-proof\.spec\.ts/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
		viewport: { width: 1120, height: 720 },
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"bunx vite --config harness/vite.voice-island-mode-proof.config.ts",
		url: `${PROOF_URL}voice-island-mode-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
