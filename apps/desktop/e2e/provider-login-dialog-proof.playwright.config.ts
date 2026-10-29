import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5357/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-provider-login-dialog-playwright-results`,
	testDir: ".",
	testMatch: /provider-login-dialog-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		// The device-code case reads back what Copy code wrote.
		permissions: ["clipboard-read", "clipboard-write"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.provider-login-dialog-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
