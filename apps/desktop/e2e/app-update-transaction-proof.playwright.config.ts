import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "app-update-transaction-proof.spec.ts",
	outputDir: "../test-results/app-update-transaction-proof",
	workers: 1,
	retries: 0,
	forbidOnly: true,
	timeout: 120_000,
	use: { baseURL: "http://127.0.0.1:5269", ...devices["Desktop Chrome"] },
	webServer: {
		cwd: path.resolve(import.meta.dirname, ".."),
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.app-update-transaction.config.ts --port 5269",
		url: "http://127.0.0.1:5269/app-update-transaction-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
