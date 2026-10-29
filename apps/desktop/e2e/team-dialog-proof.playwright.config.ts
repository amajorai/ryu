import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5383/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-team-dialog-playwright-results`,
	testDir: ".",
	testMatch: /team-dialog-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { height: 960, width: 1280 },
	},
	webServer: {
		command: "bunx vite --config harness/vite.team-dialog-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: `${baseURL}team-dialog-proof.html`,
	},
});
