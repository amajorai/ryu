import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.RYU_E2E_PORT ?? "5178");

export default defineConfig({
	testDir: "./e2e",
	testMatch: /composer-plus-story\.spec\.ts/,
	workers: 1,
	fullyParallel: false,
	timeout: 90_000,
	reporter: "list",
	use: {
		baseURL: `http://localhost:${port}/`,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.composer-plus.config.ts",
		url: `http://localhost:${port}/`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
