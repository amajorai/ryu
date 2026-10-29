import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "titlebar-actions-proof.spec.ts",
	workers: 1,
	timeout: 90_000,
	expect: { timeout: 6000 },
	fullyParallel: false,
	reporter: "list",
	use: {
		actionTimeout: 8000,
		baseURL: "http://127.0.0.1:5177",
		viewport: { width: 1280, height: 900 },
	},
	webServer: {
		command: "bunx vite --config harness/vite.titlebar-actions-proof.config.ts",
		url: "http://127.0.0.1:5177/titlebar-actions-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
