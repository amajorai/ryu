import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5197/";

export default defineConfig({
	testDir: ".",
	testMatch: /import-setup-dialog-interactions\.spec\.ts$/,
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
			"bun x vite --config harness/vite.import-setup-dialog-interactions.config.ts --host 127.0.0.1 --port 5197 --strictPort",
		url: `${baseURL}import-setup-dialog-interactions.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
