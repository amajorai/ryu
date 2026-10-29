import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /subscription-visibility\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	outputDir: path.resolve(
		import.meta.dirname,
		"../../../node_modules/.cache/ryu-subscription-visibility-results"
	),
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5219",
		viewport: { width: 1200, height: 900 },
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.subscription-visibility.config.ts",
		url: "http://127.0.0.1:5219/subscription-visibility-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
