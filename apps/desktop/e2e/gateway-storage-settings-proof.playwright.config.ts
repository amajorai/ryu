import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5247/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-gateway-storage-playwright-results`,
	testDir: ".",
	testMatch: /gateway-storage-settings-proof\.spec\.ts$/,
	// The spec is split across files under the token limit; one worker keeps
	// them in the original order against the shared harness state.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	use: {
		acceptDownloads: true,
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-storage-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
