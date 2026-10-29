import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5291/";

export default defineConfig({
	testDir: ".",
	testMatch: /calendar-companion-proof\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	use: {
		baseURL,
		viewport: { width: 1440, height: 960 },
		...devices["Desktop Chrome"],
		locale: "en-US",
		trace: "retain-on-failure",
	},
	webServer: {
		command: "bunx vite --config e2e/calendar-companion-proof/vite.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}calendar-companion-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
