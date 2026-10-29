import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5253/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-byok-integration-playwright-results`,
	testDir: ".",
	testMatch: /gateway-byok-integration-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-byok-integration-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
