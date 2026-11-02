import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5398/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-marketplace-publish-dialog-playwright-results`,
	testDir: ".",
	testMatch: /marketplace-publish-dialog-proof\.spec\.ts$/,
	// The spec is split across files under the token limit; one worker keeps
	// them in the original order against the shared harness state.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { height: 1000, width: 1280 },
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.marketplace-publish-dialog-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: `${baseURL}marketplace-publish-dialog-proof.html`,
	},
});
