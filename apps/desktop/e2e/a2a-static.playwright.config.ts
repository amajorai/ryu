import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const directory = process.env.RYU_A2A_SETTINGS_DIST;
if (
	!(
		directory &&
		path.isAbsolute(directory) &&
		existsSync(path.join(directory, "a2a-settings-proof.html"))
	)
) {
	throw new Error(
		"Build authentic A2A harness into RYU_A2A_SETTINGS_DIST first"
	);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export default defineConfig({
	testDir: ".",
	testMatch: /a2a-settings-proof\.spec\.ts$/,
	workers: 1,
	fullyParallel: false,
	retries: 0,
	forbidOnly: true,
	use: {
		baseURL: "http://127.0.0.1:5188/",
		permissions: ["clipboard-read", "clipboard-write"],
		...devices["Desktop Chrome"],
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: {
		command: `python3 -m http.server 5188 --bind 127.0.0.1 --directory ${quote(directory)}`,
		url: "http://127.0.0.1:5188/a2a-settings-proof.html",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
