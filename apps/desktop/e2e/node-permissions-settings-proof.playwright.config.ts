import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5270/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-node-permissions-playwright-results`,
	testDir: ".",
	testMatch: /node-permissions-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: { baseURL, ...devices["Desktop Chrome"] },
	webServer: {
		command:
			"bunx vite --config harness/vite.node-permissions-settings-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
