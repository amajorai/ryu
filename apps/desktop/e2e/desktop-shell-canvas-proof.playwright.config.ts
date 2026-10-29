import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /desktop-shell-canvas-proof\.spec\.ts$/,
	workers: 1,
	expect: { timeout: 30_000 },
	timeout: 60_000,
	outputDir: "/tmp/ryu-desktop-shell-canvas-proof-results",
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5418",
		viewport: { width: 1180, height: 820 },
		trace: "off",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.desktop-shell-canvas-proof.config.ts --host 127.0.0.1 --strictPort --port 5418",
		url: "http://127.0.0.1:5418/desktop-shell-canvas-proof.html",
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
