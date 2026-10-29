import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5237";

export default defineConfig({
	testDir: ".",
	testMatch: /clips-quick-attach-destination-proof\.spec\.ts$/,
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	outputDir: "test-results/clips-quick-attach-destination",
	retries: 0,
	reporter: "list",
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.clips-quick-attach-destination-proof.config.ts",
		url: `${baseURL}/clips-quick-attach-destination-proof.html`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
