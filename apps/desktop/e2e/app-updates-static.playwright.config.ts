import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const directory = process.env.RYU_APP_UPDATES_SETTINGS_DIST;
if (
	!(
		directory &&
		path.isAbsolute(directory) &&
		existsSync(path.join(directory, "app-updates-settings-proof.html"))
	)
) {
	throw new Error(
		"Build authentic app-updates-settings harness into explicit RYU_APP_UPDATES_SETTINGS_DIST first"
	);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export default defineConfig({
	testDir: ".",
	testMatch: "app-updates-settings-proof.spec.ts",
	workers: 1,
	fullyParallel: false,
	retries: 0,
	forbidOnly: true,
	timeout: 120_000,
	use: {
		baseURL: "http://127.0.0.1:5206",
		...devices["Desktop Chrome"],
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: {
		command: `python3 -m http.server 5206 --bind 127.0.0.1 --directory ${quote(directory)}`,
		url: "http://127.0.0.1:5206/app-updates-settings-proof.html",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
