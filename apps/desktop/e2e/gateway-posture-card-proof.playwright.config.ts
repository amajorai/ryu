import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5393/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-posture-card-playwright-results`,
	testDir: ".",
	testMatch: /gateway-posture-card-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		permissions: ["clipboard-read", "clipboard-write"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-posture-card-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
