import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5418/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-node-routing-settings-playwright-results`,
	testDir: ".",
	testMatch: /node-routing-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 980 },
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.node-routing-settings-proof.config.ts",
		url: `${baseURL}node-routing-settings-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
