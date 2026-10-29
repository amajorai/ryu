import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5522/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-browser-annotations-caller-playwright-results`,
	testDir: ".",
	testMatch: /browser-annotations-caller-proof\.spec\.ts$/,
	fullyParallel: false,
	timeout: 120_000,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1000 },
		trace: "off",
	},
	webServer: {
		command:
			"node ../node_modules/vite/bin/vite.js --config harness/vite.browser-annotations-caller-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
