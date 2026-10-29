import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5307/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-connections-tab-playwright-results`,
	testDir: ".",
	testMatch: /connections-tab-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bun run vite --config harness/vite.connections-tab-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
