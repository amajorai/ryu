import { tmpdir } from "node:os";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /marketplace-version-install-proof\.spec\.ts$/,
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 90_000,
	outputDir: `${tmpdir()}/ryu-marketplace-version-install-proof-results`,
	use: {
		baseURL: "http://127.0.0.1:5436",
		viewport: { width: 1440, height: 960 },
		actionTimeout: 15_000,
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.marketplace-version-install-proof.config.ts",
		url: "http://127.0.0.1:5436/marketplace-version-install-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
