import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5196/";

export default defineConfig({
	testDir: ".",
	testMatch: /agent-run-history-interactions\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "list",
	use: {
		baseURL,
		viewport: { width: 1440, height: 1000 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bun x vite --config harness/vite.agent-run-history-interactions.config.ts --host 127.0.0.1 --port 5196 --strictPort",
		url: `${baseURL}agent-run-history-interactions.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
