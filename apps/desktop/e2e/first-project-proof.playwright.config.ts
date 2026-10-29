import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /first-project-proof\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	forbidOnly: true,
	retries: 0,
	timeout: 45_000,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5296",
		trace: "retain-on-failure",
		viewport: { width: 1280, height: 900 },
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	outputDir: path.resolve(
		import.meta.dirname,
		"../test-results/first-project-proof"
	),
	webServer: {
		command:
			"bunx vite --config harness/vite.first-project-proof.config.ts --host 127.0.0.1 --port 5296 --strictPort",
		url: "http://127.0.0.1:5296/first-project-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
