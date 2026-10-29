import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const directory = process.env.RYU_TIME_DATES_DIST;
const story = process.env.RYU_TIME_DATES_STORY ?? "timezone-picker-story.html";
if (
	!(
		directory &&
		path.isAbsolute(directory) &&
		existsSync(path.join(directory, story))
	)
) {
	throw new Error(
		"Build the authentic time/date story into RYU_TIME_DATES_DIST first"
	);
}
const port = Number(process.env.RYU_E2E_PORT ?? "5183");
const baseURL = `http://127.0.0.1:${port}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export default defineConfig({
	testDir: ".",
	testMatch: /(?:timezone-picker-story|sidebar-mounted-midnight)\.spec\.ts$/,
	workers: 1,
	fullyParallel: false,
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
		command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory ${quote(directory)}`,
		url: `${baseURL}/${story}`,
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
