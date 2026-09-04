import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5180/";

export default defineConfig({
	testDir: ".",
	testMatch: /tab-renames-proof\.spec\.ts/,
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
			use: {
				...devices["Desktop Chrome"],
				viewport: { height: 900, width: 1440 },
			},
		},
	],
	webServer: {
		command: "bunx vite --config harness/vite.tab-renames-proof.config.ts",
		url: `${PROOF_URL}tab-renames-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
