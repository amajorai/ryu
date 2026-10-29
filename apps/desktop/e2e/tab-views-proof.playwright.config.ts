import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5179/";

export default defineConfig({
	testDir: ".",
	testMatch: /tab-views-proof\.spec\.ts/,
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
				// Opt-in installed Chromium when the locked Playwright build is absent.
				launchOptions: {
					executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
				},
			},
		},
	],
	webServer: {
		command: "bunx vite --config harness/vite.tab-views-proof.config.ts",
		url: `${PROOF_URL}tab-views-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
