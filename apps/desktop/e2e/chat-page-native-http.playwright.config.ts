import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /chat-page-native-http-.*\.(?:proof|spec)\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	use: {
		...devices["Desktop Chrome"],
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
		baseURL: "http://127.0.0.1:5590",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: [
		{
			command: "bun e2e/chat-page-native-http.host.ts",
			cwd: path.resolve(import.meta.dirname, ".."),
			url: "http://127.0.0.1:5591/__ready",
			reuseExistingServer: false,
			timeout: 60_000,
		},
		{
			command:
				"bunx vite --config e2e/harness/vite.chat-page-native-http.config.ts",
			cwd: path.resolve(import.meta.dirname, ".."),
			url: "http://127.0.0.1:5590/chat-page-native-http.html",
			reuseExistingServer: false,
			timeout: 120_000,
		},
	],
});
