import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5217/";

export default defineConfig({
	fullyParallel: false,
	reporter: "list",
	retries: 0,
	testDir: ".",
	testMatch: /private-package-share-create-proof\.spec\.ts/,
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
		command:
			"bunx vite --config harness/vite.private-package-share-create-proof.config.ts",
		reuseExistingServer: false,
		url: PROOF_URL,
		timeout: 120_000,
	},
});
