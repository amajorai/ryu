import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /diff-review-proof\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	outputDir: "/tmp/ryu-diff-review-proof-results",
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5387",
		viewport: { width: 1180, height: 820 },
		trace: "off",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.diff-review-proof.config.ts --host 127.0.0.1 --strictPort --port 5387",
		url: "http://127.0.0.1:5387/diff-review-proof.html",
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
