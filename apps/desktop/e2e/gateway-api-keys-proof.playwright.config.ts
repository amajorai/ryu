import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5248/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-api-keys-playwright-results`,
	testDir: ".",
	testMatch: /gateway-api-keys-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "bunx vite --config harness/vite.gateway-api-keys-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
