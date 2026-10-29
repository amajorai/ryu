import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5417/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-node-selector-interactions-results`,
	testDir: ".",
	testMatch: /node-selector-interactions-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.node-selector-proof.config.ts --port 5417",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
