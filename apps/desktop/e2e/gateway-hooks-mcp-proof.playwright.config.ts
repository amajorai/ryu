import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5259/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-hooks-mcp-playwright-results`,
	testDir: ".",
	testMatch: /gateway-hooks-mcp-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-hooks-mcp-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
