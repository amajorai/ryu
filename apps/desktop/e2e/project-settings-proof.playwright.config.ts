import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5398/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-project-settings-playwright-results`,
	globalSetup: "./harness/project-settings-proof.global-setup.ts",
	testDir: ".",
	testMatch: /project-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "bunx vite --config harness/vite.project-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
