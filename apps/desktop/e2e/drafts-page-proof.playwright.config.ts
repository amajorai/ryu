import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5405/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-drafts-page-playwright-results`,
	testDir: ".",
	testMatch: /drafts-page-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "list",
	use: {
		baseURL,
		viewport: { width: 1440, height: 1000 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bun x vite --config harness/vite.drafts-page-proof.config.ts --host 127.0.0.1 --port 5405 --strictPort",
		url: `${baseURL}drafts-page-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
