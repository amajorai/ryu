import { defineConfig, devices } from "@playwright/test";

const BASE_PORT = process.env.RYU_MARKETPLACE_STORE_MODELS_PORT ?? "5190";
const BASE_URL = `http://127.0.0.1:${BASE_PORT}`;

export default defineConfig({
	testDir: ".",
	// Pays the cold Vite compile of the Store story once, outside every test.
	globalSetup: "./harness/marketplace-store-warmup.global-setup.ts",
	testMatch: /marketplace-store-models\.spec\.ts/,
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
			"bunx vite --config harness/vite.marketplace-store-models.config.ts",
		url: `${BASE_URL}/marketplace-store-models.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
