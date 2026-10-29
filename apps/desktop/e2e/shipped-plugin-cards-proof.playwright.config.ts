import { defineConfig, devices } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:5191";

export default defineConfig({
	timeout: 60_000,
	testDir: ".",
	testMatch: /shipped-plugin-cards-proof\.spec\.ts/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		viewport: { width: 1440, height: 1000 },
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 1000 },
			},
		},
	],
	webServer: {
		command: "bunx vite --config harness/vite.marketplace-store-home.config.ts",
		url: `${BASE_URL}/marketplace-store-home.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
