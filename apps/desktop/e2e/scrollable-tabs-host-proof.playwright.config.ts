import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /scrollable-tabs-host-proof\.spec\.ts$/,
	workers: 1,
	expect: { timeout: 30_000 },
	timeout: 60_000,
	outputDir: "/tmp/ryu-scrollable-tabs-host-proof-results",
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5388",
		viewport: { width: 1180, height: 820 },
		trace: "off",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.scrollable-tabs-host-proof.config.ts --host 127.0.0.1 --strictPort --port 5388",
		url: "http://127.0.0.1:5388/scrollable-tabs-host-proof.html",
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
