import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5179/";

export default defineConfig({
	testDir: ".",
	testMatch: /managed-openrouter-routing-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "list",
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1050 },
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.managed-openrouter-routing-proof.config.ts --host 127.0.0.1",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
