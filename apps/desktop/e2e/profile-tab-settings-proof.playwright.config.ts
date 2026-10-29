import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:55813/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-profile-tab-settings-playwright-results`,
	testDir: ".",
	testMatch: /profile-tab-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	timeout: 45_000,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1000 },
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.profile-tab-settings-proof.config.ts",
		url: `${baseURL}profile-tab-settings-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
