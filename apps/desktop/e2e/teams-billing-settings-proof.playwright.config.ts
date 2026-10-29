import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5367/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-teams-billing-settings-playwright-results`,
	testDir: ".",
	testMatch: /teams-billing-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { height: 900, width: 1440 },
	},
	webServer: {
		command:
			"bun run vite --config harness/vite.teams-billing-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
