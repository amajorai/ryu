import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /agent-sync-proof\.spec\.ts$/,
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://localhost:5178/",
		viewport: { height: 1000, width: 1600 },
	},
	webServer: {
		command: "bunx vite --config harness/vite.agent-sync-proof.config.ts",
		url: "http://localhost:5178/agent-sync-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
