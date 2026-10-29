import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5437/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-library-source-playwright-results`,
	testDir: ".",
	testMatch: /library-source-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "bunx vite --config harness/vite.library-source-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
