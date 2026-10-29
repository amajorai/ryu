import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5327/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-eval-tooltip-playwright-results`,
	fullyParallel: false,
	timeout: 90_000,
	retries: 0,
	testDir: ".",
	testMatch: /gateway-eval-result-tooltip-proof\.spec\.ts$/,
	use: { baseURL, ...devices["Desktop Chrome"] },
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-eval-result-tooltip-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
