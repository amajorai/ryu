import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5489/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-web-product-demo-previews-playwright-results`,
	testDir: ".",
	testMatch: /web-product-demo-previews-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		trace: "on-first-retry",
	},
	webServer: {
		command:
			"bun run vite --config harness/vite.web-product-demo-previews-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
