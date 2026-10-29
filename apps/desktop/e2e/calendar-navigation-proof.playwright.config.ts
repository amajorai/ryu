import { tmpdir } from "node:os";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /calendar-navigation-proof\.spec\.ts$/,
	workers: 1,
	retries: 0,
	reporter: "list",
	outputDir: `${tmpdir()}/ryu-calendar-navigation-results`,
	use: {
		baseURL: "http://127.0.0.1:5391",
		viewport: { width: 1280, height: 900 },
		timezoneId: "UTC",
		trace: "off",
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.calendar-navigation-proof.config.ts",
		url: "http://127.0.0.1:5391/calendar-navigation-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
