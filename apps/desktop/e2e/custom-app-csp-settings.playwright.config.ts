import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "custom-app-csp-settings.spec.ts",
	outputDir: "../test-results/custom-app-csp-settings",
	workers: 1,
	use: { baseURL: "http://127.0.0.1:5267", ...devices["Desktop Chrome"] },
	webServer: {
		cwd: path.resolve(import.meta.dirname, ".."),
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.harness.config.ts --port 5267",
		url: "http://127.0.0.1:5267/custom-app-csp-settings-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
