import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5281/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-usage-cost-playwright-results`,
	testDir: ".",
	testMatch: /gateway-usage-cost-proof\.spec\.ts$/,
	fullyParallel: false,
	timeout: 90_000,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-usage-cost-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
