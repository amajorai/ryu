import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /extension-global-proof\.spec\.ts$/,
	timeout: 180_000,
	expect: { timeout: 45_000 },
	reporter: "line",
	outputDir: "../../../docs/proof/extension-parity/global-browser",
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://127.0.0.1:5234",
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite preview --config harness/vite.extension-global-proof.config.ts",
		url: "http://127.0.0.1:5234/extension-global-proof.html",
		reuseExistingServer: true,
		timeout: 180_000,
	},
});
