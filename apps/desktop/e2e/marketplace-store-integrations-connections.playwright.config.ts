import { defineConfig } from "@playwright/test";
import original from "./marketplace-store-catalogs.playwright.config.ts";

const baseURL = "http://127.0.0.1:5493";
// Spread rather than `defineConfig(original, ...)`: merging configs appends web
// servers, which would also start the catalogs story on its own port beside this
// one, compiling into the same dependency cache while nothing here uses it.
export default defineConfig({
	...original,
	testMatch:
		/marketplace-store-(?:catalogs|integrations-connections)\.spec\.ts/,
	outputDir: "test-results/store-integrations-connections",
	use: { ...original.use, baseURL, trace: "off" },
	webServer: {
		command:
			"bunx vite --config harness/vite.marketplace-store-catalogs.config.ts --port 5493",
		url: `${baseURL}/marketplace-store-catalogs.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
