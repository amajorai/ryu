import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5252/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-project-environments-playwright-results`,
	testDir: ".",
	testMatch: /gateway-project-environments-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		navigationTimeout: 120_000,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-project-environments-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
