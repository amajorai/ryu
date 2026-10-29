import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /space-scope-menu-proof\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	outputDir: "/tmp/ryu-space-scope-menu-proof-results",
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5517",
		viewport: { width: 940, height: 760 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite build --emptyOutDir --config harness/vite.space-scope-menu-proof.config.ts --outDir /tmp/ryu-space-scope-menu-proof-preview-5517 && bunx vite preview --config harness/vite.space-scope-menu-proof.config.ts --outDir /tmp/ryu-space-scope-menu-proof-preview-5517 --host 127.0.0.1 --strictPort --port 5517",
		url: "http://127.0.0.1:5517/space-scope-menu-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
