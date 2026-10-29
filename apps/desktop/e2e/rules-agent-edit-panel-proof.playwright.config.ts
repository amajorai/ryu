import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5386/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-rules-agent-edit-panel-playwright-results`,
	testDir: ".",
	testMatch: /rules-agent-edit-panel-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1100 },
	},
	webServer: {
		command:
			"bun x vite --config harness/vite.rules-agent-edit-panel-proof.config.ts --host 127.0.0.1 --port 5386 --strictPort",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
