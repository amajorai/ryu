import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5336/";
export default defineConfig({
	testDir: ".",
	testMatch: /marketplace-detail-proof\.spec\.ts$/,
	outputDir: `${tmpdir()}/ryu-marketplace-detail-proof-results`,
	fullyParallel: false,
	retries: 0,
	timeout: 120_000,
	use: {
		actionTimeout: 15_000,
		...devices["Desktop Chrome"],
		baseURL,
		trace: "off",
		screenshot: "off",
		video: "off",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.marketplace-detail-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
