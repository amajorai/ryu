import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5341/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-agent-models-settings-playwright-results`,
	testDir: ".",
	testMatch: /agent-models-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bun run vite --config harness/vite.agent-models-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
