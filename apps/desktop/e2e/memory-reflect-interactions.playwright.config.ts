import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5199/";

export default defineConfig({
	testDir: ".",
	testMatch: /memory-reflect-interactions\.spec\.ts$/,
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
			"bun x vite --config harness/vite.memory-reflect-interactions.config.ts --host 127.0.0.1 --port 5199 --strictPort",
		url: `${baseURL}memory-reflect-interactions.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
