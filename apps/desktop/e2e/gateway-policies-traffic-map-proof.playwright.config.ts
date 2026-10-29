import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5271/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-policies-traffic-map-playwright-results`,
	testDir: ".",
	testMatch: /gateway-policies-traffic-map-proof\.spec\.ts$/,
	fullyParallel: true,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 900 },
	},
	workers: 2,
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-traffic-map-proof.config.ts",
		reuseExistingServer: true,
		timeout: 120_000,
		url: baseURL,
	},
});
