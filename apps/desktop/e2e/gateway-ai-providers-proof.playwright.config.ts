import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5297/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-ai-providers-playwright-results`,
	testDir: ".",
	testMatch: /gateway-ai-providers-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-ai-providers-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
