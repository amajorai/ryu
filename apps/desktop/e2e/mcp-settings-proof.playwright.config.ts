import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /mcp-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	// Leave time for Chromium context teardown on the shared Windows build host.
	timeout: 240_000,
	expect: { timeout: 30_000 },
	reporter: "line",
	outputDir: "../../../docs/proof/extension-parity/settings-browser",
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://127.0.0.1:5237",
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.mcp-settings-proof.config.ts --port 5237",
		url: "http://127.0.0.1:5237/mcp-settings-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
