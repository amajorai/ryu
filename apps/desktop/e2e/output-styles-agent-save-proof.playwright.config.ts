import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5459/";
export default defineConfig({
	outputDir: `${tmpdir()}/ryu-output-styles-agent-save-results`,
	testDir: ".",
	testMatch: /output-styles-agent-save-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1100 },
	},
	webServer: {
		command:
			"bun x vite --config harness/vite.output-styles-agent-save-proof.config.ts --host 127.0.0.1 --port 5459 --strictPort",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
