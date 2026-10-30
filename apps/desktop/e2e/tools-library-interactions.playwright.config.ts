import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /tools-library-interactions(\.server)?\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	outputDir: "/tmp/ryu-tools-library-interactions-results",
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5224",
		viewport: { width: 1440, height: 960 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.tools-library-interactions.config.ts",
		url: "http://127.0.0.1:5224/tools-library-interactions.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
