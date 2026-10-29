import { defineConfig } from "@playwright/test";
import original from "./marketplace-store-sources-catalogs.playwright.config.ts";
export default defineConfig({
	...original,
	timeout: 60_000,
	workers: 1,
	testMatch: /marketplace-store-sources-contributed\.spec\.ts/,
	outputDir: "test-results/marketplace-store-sources-contributed",
	use: {
		...original.use,
		baseURL: "http://127.0.0.1:5493",
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.marketplace-store-sources-contributed.config.ts",
		url: "http://127.0.0.1:5493/marketplace-store-sources-contributed.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
