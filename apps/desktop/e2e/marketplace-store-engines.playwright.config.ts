import { defineConfig } from "@playwright/test";
import homeConfig from "./marketplace-store-home.playwright.config.ts";

const BASE_URL = "http://127.0.0.1:5491";
process.env.RYU_STORE_TEST_API_ORIGIN = BASE_URL;

// Reuse production StorePage cases and transport fixtures. Settings-only and
// Library tests remain in their owning suites.
export default defineConfig({
	...homeConfig,
	grep: /Engine |Engines |Installed engine |Image |Sandbox |llama\.cpp acceleration/,
	outputDir: "test-results/marketplace-store-engines",
	use: { ...homeConfig.use, baseURL: BASE_URL, trace: "off" },
	webServer: {
		command:
			"bunx vite --config harness/vite.marketplace-store-home.config.ts --port 5491",
		url: `${BASE_URL}/marketplace-store-home.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
