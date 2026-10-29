import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5452/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-app-sidebar-interactions-playwright-results`,
	testDir: ".",
	testMatch: /app-sidebar-interactions-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.app-sidebar-interactions-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
