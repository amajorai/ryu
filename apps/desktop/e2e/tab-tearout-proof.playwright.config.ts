import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "tab-tearout-proof.spec.ts",
	workers: 1,
	timeout: 90_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5173",
		viewport: { width: 1200, height: 800 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command: "bunx vite --config harness/vite.tab-tearout-proof.config.ts",
		url: "http://127.0.0.1:5173",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
