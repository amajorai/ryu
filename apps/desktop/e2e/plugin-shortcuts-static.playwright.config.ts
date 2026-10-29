import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const directory = process.env.RYU_PLUGIN_SHORTCUTS_DIST;
if (
	!(
		directory &&
		path.isAbsolute(directory) &&
		existsSync(path.join(directory, "index.html"))
	)
) {
	throw new Error(
		"Build authentic plugin shortcut harness into explicit RYU_PLUGIN_SHORTCUTS_DIST first"
	);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "plugin-shortcuts-proof.spec.ts",
	workers: 1,
	fullyParallel: false,
	retries: 0,
	forbidOnly: true,
	timeout: 60_000,
	use: {
		baseURL: "http://127.0.0.1:33368",
		headless: true,
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: [
		{
			command: "bun harness/plugin-shortcuts-proof/host.ts",
			url: "http://127.0.0.1:33367/health",
			reuseExistingServer: false,
			timeout: 30_000,
		},
		{
			command: `python3 -m http.server 33368 --bind 127.0.0.1 --directory ${quote(directory)}`,
			url: "http://127.0.0.1:33368/index.html",
			reuseExistingServer: false,
			timeout: 30_000,
		},
	],
});
