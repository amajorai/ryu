import { defineConfig, devices } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:5193";

export default defineConfig({
	testDir: ".",
	// Pays the cold Vite compile of the Store story once, outside every test.
	globalSetup: "./harness/marketplace-store-warmup.global-setup.ts",
	testMatch: /marketplace-store-catalogs\.spec\.ts/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		viewport: { width: 1440, height: 1000 },
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command:
			"bunx vite --config harness/vite.marketplace-store-catalogs.config.ts",
		url: `${BASE_URL}/marketplace-store-catalogs.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
