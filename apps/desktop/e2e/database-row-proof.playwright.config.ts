import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5335/";
export default defineConfig({
	testDir: ".",
	testMatch: /database-row-proof\.spec\.ts$/,
	outputDir: `${tmpdir()}/ryu-database-row-proof-results`,
	fullyParallel: false,
	retries: 0,
	timeout: 90_000,
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		trace: "off",
		screenshot: "off",
		video: "off",
	},
	webServer: {
		command: "bunx vite --config harness/vite.database-row-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
