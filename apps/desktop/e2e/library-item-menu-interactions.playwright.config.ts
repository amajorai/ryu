import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5198/";

export default defineConfig({
	testDir: ".",
	testMatch: /library-item-menu-interactions\.spec\.ts$/,
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
			"bun x vite --config harness/vite.library-item-menu-interactions.config.ts --host 127.0.0.1 --port 5198 --strictPort",
		url: `${baseURL}library-item-menu-interactions.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
