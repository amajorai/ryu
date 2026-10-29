import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5431/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-navuser-interactions-playwright-results`,
	testDir: ".",
	testMatch: /navuser-interactions-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { height: 1000, width: 1440 },
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.navuser-interactions-proof.config.ts",
		url: `${baseURL}navuser-interactions-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
