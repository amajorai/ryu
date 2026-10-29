import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "device-permissions-proof.spec.ts",
	workers: 1,
	use: {
		baseURL: "http://127.0.0.1:5197",
		viewport: { width: 1100, height: 800 },
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bun x vite --config harness/vite.device-permissions-proof.config.ts",
		url: "http://127.0.0.1:5197/device-permissions-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
