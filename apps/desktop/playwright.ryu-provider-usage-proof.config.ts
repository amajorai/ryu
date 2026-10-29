import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	testMatch: /ryu-provider-usage-proof\.spec\.ts/,
	fullyParallel: true,
	use: {
		baseURL: "http://localhost:5178/",
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.ryu-provider-usage-proof.config.ts",
		url: "http://localhost:5178/",
		reuseExistingServer: false,
		gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
		timeout: 120_000,
	},
});
