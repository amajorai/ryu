import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /extension-parity-proof\.spec\.ts$/,
	fullyParallel: false,
	timeout: 180_000,
	retries: 0,
	expect: { timeout: 60_000 },
	reporter: "line",
	outputDir: "../../../docs/proof/extension-parity/browser",
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://127.0.0.1:5232",
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite preview --config harness/vite.extension-parity-proof.config.ts",
		url: "http://127.0.0.1:5232/extension-parity-proof.html",
		reuseExistingServer: true,
		timeout: 180_000,
	},
});
