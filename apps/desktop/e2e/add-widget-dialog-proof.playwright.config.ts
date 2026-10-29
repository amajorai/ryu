import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5276/";

export default defineConfig({
	testDir: path.resolve(import.meta.dirname),
	testMatch: "add-widget-dialog-proof.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	use: {
		baseURL,
		viewport: { height: 900, width: 1440 },
		...devices["Desktop Chrome"],
		locale: "en-US",
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.add-widget-dialog-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}add-widget-dialog-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
