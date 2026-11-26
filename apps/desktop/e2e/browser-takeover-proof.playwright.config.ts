import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5899/";
// Set to a Chromium binary when the Playwright browser revision is not installed.
const executablePath = process.env.RYU_E2E_CHROMIUM || undefined;

export default defineConfig({
	testDir: path.resolve(import.meta.dirname),
	testMatch: "browser-takeover-proof.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	// The first page load compiles the desktop styles and the panel's imports.
	timeout: 120_000,
	expect: { timeout: 15_000 },
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { height: 800, width: 1280 },
		locale: "en-US",
		launchOptions: { executablePath },
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.browser-takeover-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}browser-takeover-proof.html`,
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
