import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5287/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-agent-budget-panel-sweep-playwright-results`,
	testDir: ".",
	testMatch: /agent-budget-panel-sweep\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: { baseURL, ...devices["Desktop Chrome"] },
	webServer: {
		command:
			"bunx vite --config harness/vite.agent-budget-panel-sweep.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
