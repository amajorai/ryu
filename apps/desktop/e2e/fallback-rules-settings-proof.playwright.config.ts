import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5365/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-fallback-rules-playwright-results`,
	testDir: ".",
	testMatch: /fallback-rules-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	timeout: 90_000,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { height: 980, width: 1440 },
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.fallback-rules-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
