import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /app-sidebar-controls-proof\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	outputDir: "/tmp/ryu-app-sidebar-controls-proof-results",
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5236",
		viewport: { width: 640, height: 620 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite build --emptyOutDir --config harness/vite.app-sidebar-controls-proof.config.ts --outDir /tmp/ryu-app-sidebar-controls-proof-preview-5236 && bunx vite preview --config harness/vite.app-sidebar-controls-proof.config.ts --outDir /tmp/ryu-app-sidebar-controls-proof-preview-5236 --host 127.0.0.1 --strictPort --port 5236",
		url: "http://127.0.0.1:5236/app-sidebar-controls-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
