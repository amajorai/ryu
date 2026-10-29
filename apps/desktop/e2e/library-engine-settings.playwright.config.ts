import { tmpdir } from "node:os";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	timeout: 60_000,
	expect: { timeout: 10_000 },
	outputDir: `${tmpdir()}/ryu-library-engine-proof`,
	testDir: ".",
	// Pays the cold Vite compile of the Store story once, outside every test.
	globalSetup: "./harness/marketplace-store-warmup.global-setup.ts",
	testMatch: /marketplace-store-home\.spec\.ts/,
	grep: /Library engines/,
	fullyParallel: false,
	use: {
		baseURL: "http://127.0.0.1:5192",
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.library-engine-settings.config.ts",
		url: "http://127.0.0.1:5192/library-engine-settings.html",
		reuseExistingServer: false,
	},
});
