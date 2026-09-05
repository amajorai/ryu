import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5186/";

export default defineConfig({
	testDir: ".",
	testMatch: /tab-memory-proof\.spec\.ts$/,
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
		command: "bunx vite --config harness/vite.tab-memory-proof.config.ts",
		url: `${PROOF_URL}tab-memory-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
