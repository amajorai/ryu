import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5184/";

export default defineConfig({
	testDir: ".",
	testMatch: /agent-routines-interactions\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	use: {
		baseURL,
		viewport: { width: 1440, height: 1200 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bun x vite --config harness/vite.agent-routines-interactions.config.ts --host 127.0.0.1 --port 5184 --strictPort",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
