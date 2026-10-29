import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.RYU_E2E_PORT ?? "5183");
const baseURL = `http://127.0.0.1:${port}`;
const story = process.env.RYU_TIME_DATES_STORY ?? "timezone-picker-story.html";
export default defineConfig({
	testDir: ".",
	testMatch: /(?:timezone-picker-story|sidebar-mounted-midnight)\.spec\.ts$/,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	reporter: "line",
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.time-dates.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}/${story}`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
