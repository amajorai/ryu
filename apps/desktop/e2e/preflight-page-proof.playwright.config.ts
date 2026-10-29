import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5301/";

export default defineConfig({
	fullyParallel: false,
	outputDir: `${tmpdir()}/ryu-preflight-page-playwright-results-v6`,
	retries: 0,
	testDir: ".",
	testMatch: /preflight-page-proof\.spec\.ts$/,
	timeout: 90_000,
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		trace: "off",
		video: "off",
		screenshot: "off",
	},
	webServer: {
		command: "bunx vite --config harness/vite.preflight-page-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
