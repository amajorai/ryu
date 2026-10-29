import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5334/";
export default defineConfig({
	testDir: ".",
	testMatch: /column-editor-proof\.spec\.ts$/,
	outputDir: `${tmpdir()}/ryu-column-editor-proof-results`,
	fullyParallel: false,
	retries: 0,
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		trace: "off",
		screenshot: "off",
		video: "off",
	},
	webServer: {
		command: "bunx vite --config harness/vite.column-editor-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
