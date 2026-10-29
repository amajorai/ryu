import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5391/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-agent-smart-route-override-playwright-results`,
	testDir: ".",
	testMatch: /agent-smart-route-override-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	timeout: 60_000,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1200 },
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.agent-smart-route-override-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
