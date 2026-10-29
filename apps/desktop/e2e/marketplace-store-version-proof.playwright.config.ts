import { tmpdir } from "node:os";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /marketplace-store-version-proof\.spec\.ts$/,
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 90_000,
	outputDir: `${tmpdir()}/ryu-marketplace-store-version-proof-results`,
	use: {
		baseURL: "http://127.0.0.1:58199",
		viewport: { width: 1440, height: 960 },
		actionTimeout: 15_000,
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.marketplace-store-version-proof.config.ts",
		url: "http://127.0.0.1:58199/marketplace-store-version-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
