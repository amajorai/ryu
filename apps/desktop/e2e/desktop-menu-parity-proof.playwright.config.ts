import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5313/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-desktop-menu-parity-playwright-results`,
	testDir: ".",
	testMatch: /desktop-menu-parity-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.desktop-menu-parity-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
