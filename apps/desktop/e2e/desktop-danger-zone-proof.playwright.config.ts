import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5255/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-desktop-danger-zone-playwright-results`,
	testDir: ".",
	testMatch: /desktop-danger-zone-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.desktop-danger-zone-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
