import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5497";
export default defineConfig({
	testDir: ".",
	testMatch: /console-access-app-proof\.spec\.ts$/,
	workers: 1,
	fullyParallel: false,
	retries: 0,
	outputDir: process.env.RYU_CONSOLE_ACCESS_PROOF_DIR
		? `${process.env.RYU_CONSOLE_ACCESS_PROOF_DIR}/playwright`
		: `${tmpdir()}/ryu-console-access-app-proof-results`,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bun x vite --config harness/vite.console-access-app-proof.config.ts",
		url: `${baseURL}/console-access-app-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
