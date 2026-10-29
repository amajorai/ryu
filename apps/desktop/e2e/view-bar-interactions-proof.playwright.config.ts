import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5488/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-view-bar-interactions-playwright-results`,
	testDir: ".",
	testMatch: /view-bar-interactions-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		trace: "on-first-retry",
	},
	webServer: {
		command:
			"bun run vite --config harness/vite.view-bar-interactions-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
