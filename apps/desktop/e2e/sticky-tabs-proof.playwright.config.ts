import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /sticky-tabs-proof\.spec\.ts/,
	fullyParallel: false,
	timeout: 90_000,
	retries: 0,
	reporter: "list",
	outputDir: "../../../docs/proof/sticky-tabs-2026-09-22",
	use: { baseURL: "http://127.0.0.1:5197", trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command:
			"bunx --no-install vite --config harness/vite.sticky-tabs-proof.config.ts",
		url: "http://127.0.0.1:5197/sticky-tabs-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
