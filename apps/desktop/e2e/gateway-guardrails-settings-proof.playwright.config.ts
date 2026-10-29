import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5269/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-guardrails-playwright-results`,
	testDir: ".",
	testMatch: /gateway-guardrails-settings-proof\.spec\.ts$/,
	fullyParallel: true,
	retries: 0,
	use: { baseURL, ...devices["Desktop Chrome"] },
	workers: 3,
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-guardrails-settings-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
