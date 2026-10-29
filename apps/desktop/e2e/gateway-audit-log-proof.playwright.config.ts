import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5314/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-audit-playwright-results`,
	testDir: ".",
	testMatch: /gateway-audit-log-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: { baseURL, ...devices["Desktop Chrome"] },
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-audit-log-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
