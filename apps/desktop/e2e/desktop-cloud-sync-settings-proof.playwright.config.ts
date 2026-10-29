import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5258/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-desktop-cloud-sync-playwright-results`,
	testDir: ".",
	testMatch: /desktop-cloud-sync-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.desktop-cloud-sync-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
