import { defineConfig } from "@playwright/test";
import original from "./marketplace-store-catalogs.playwright.config.ts";

const baseURL = "http://127.0.0.1:5492";
export default defineConfig({
	...original,
	outputDir: "test-results-store-sources-catalogs",
	use: { ...original.use, baseURL, trace: "off" },
	webServer: {
		command:
			"bunx vite --config harness/vite.marketplace-store-catalogs.config.ts --port 5492",
		url: `${baseURL}/marketplace-store-catalogs.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
