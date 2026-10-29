import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5411/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-node-selector-playwright-results`,
	testDir: ".",
	testMatch: /node-selector-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "bunx vite --config harness/vite.node-selector-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
