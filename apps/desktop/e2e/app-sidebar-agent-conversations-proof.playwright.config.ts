import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /app-sidebar-agent-conversations-proof\.spec\.ts$/,
	workers: 1,
	timeout: 90_000,
	outputDir: "/tmp/ryu-app-sidebar-agent-conversations-results",
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5238",
		viewport: { width: 1120, height: 760 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite build --emptyOutDir --config harness/vite.app-sidebar-agent-conversations-proof.config.ts --outDir /tmp/ryu-app-sidebar-agent-conversations-preview-5238 && bunx vite preview --config harness/vite.app-sidebar-agent-conversations-proof.config.ts --outDir /tmp/ryu-app-sidebar-agent-conversations-preview-5238 --host 127.0.0.1 --strictPort --port 5238",
		url: "http://127.0.0.1:5238/app-sidebar-agent-conversations-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
