import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5403/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-library-collections-playwright-results`,
	testDir: ".",
	testMatch: /library-collections-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "list",
	use: {
		baseURL,
		viewport: { width: 1440, height: 1000 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bun x vite --config harness/vite.library-collections-proof.config.ts --host 127.0.0.1 --port 5403 --strictPort",
		url: `${baseURL}library-collections-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
