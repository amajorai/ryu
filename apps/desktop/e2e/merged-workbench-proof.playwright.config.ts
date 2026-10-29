import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /merged-workbench-proof\.spec\.ts$/,
	workers: 1,
	expect: { timeout: 30_000 },
	timeout: 60_000,
	outputDir: "/tmp/ryu-merged-workbench-proof-results",
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5418",
		viewport: { width: 1600, height: 1000 },
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
		trace: "off",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.desktop-shell-canvas-proof.config.ts --host 127.0.0.1 --strictPort --port 5418",
		url: "http://127.0.0.1:5418/merged-workbench-proof.html",
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
