import { defineConfig, devices } from "@playwright/test";

const proofUrl = "http://127.0.0.1:5249/";

export default defineConfig({
	testDir: ".",
	testMatch: /cloud-environments-proof\.spec\.ts$/,
	fullyParallel: false,
	timeout: 360_000,
	expect: { timeout: 60_000 },
	retries: 0,
	reporter: "line",
	use: {
		...devices["Desktop Chrome"],
		baseURL: proofUrl,
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"node ../node_modules/vite/bin/vite.js preview --config harness/vite.cloud-environments-proof.config.ts",
		url: `${proofUrl}cloud-environments-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
