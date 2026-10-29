import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5298/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-workspace-members-playwright-results`,
	testDir: ".",
	testMatch: /gateway-workspace-members-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-workspace-members-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
