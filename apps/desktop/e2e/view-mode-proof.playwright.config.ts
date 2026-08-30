import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5180/";

export default defineConfig({
	testDir: ".",
	testMatch: /view-mode-proof\.spec\.ts/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: "bunx vite --config harness/vite.view-mode-proof.config.ts",
		url: `${PROOF_URL}view-mode-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
