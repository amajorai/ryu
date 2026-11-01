import { defineConfig } from "@playwright/test";
import original from "./marketplace-store-interactions.playwright.config.ts";

const baseURL = "http://127.0.0.1:5492";
// The interactions fixture routes Core and checks the install node by this
// origin; it otherwise stays on the base config's port 5189.
process.env.RYU_STORE_TEST_API_ORIGIN = baseURL;
export default defineConfig({
	...original,
	outputDir: "test-results-store-sources-interactions",
	use: { ...original.use, baseURL, trace: "off" },
	webServer: {
		command:
			"bunx vite --config harness/vite.marketplace-store-interactions.config.ts --port 5492",
		url: `${baseURL}/marketplace-store-interactions.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
