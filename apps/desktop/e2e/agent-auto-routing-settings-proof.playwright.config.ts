import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5421/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-agent-auto-routing-settings-playwright-results`,
	testDir: ".",
	testMatch: /agent-auto-routing-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1000 },
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.agent-auto-routing-settings-proof.config.ts",
		url: `${baseURL}node-selector-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
