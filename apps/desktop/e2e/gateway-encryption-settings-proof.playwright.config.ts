import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5254/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-encryption-playwright-results`,
	testDir: ".",
	testMatch: /gateway-encryption-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-encryption-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
