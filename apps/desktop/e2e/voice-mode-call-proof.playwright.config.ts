import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5698/";

export default defineConfig({
	testDir: ".",
	testMatch: /voice-(mode-call|call-history)-proof\.spec\.ts/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		launchOptions: {
			args: [
				"--use-fake-ui-for-media-stream",
				"--use-fake-device-for-media-stream",
			],
		},
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: "bunx vite --config harness/vite.voice-mode-call-proof.config.ts",
		url: `${PROOF_URL}voice-mode-call-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
