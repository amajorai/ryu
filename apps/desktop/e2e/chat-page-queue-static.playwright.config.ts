import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const directory = path.resolve(
	process.env.RYU_CHAT_QUEUE_DIST ?? "/tmp/ryu-chat-queue-static"
);
if (!existsSync(path.join(directory, "chat-page-native-http.html"))) {
	throw new Error(
		"Build the authentic queue ChatPage harness before running its browser regression"
	);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export default defineConfig({
	testDir: ".",
	testMatch: /chat-page-native-http-queue-isolation\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	timeout: 90_000,
	use: {
		...devices["Desktop Chrome"],
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
		baseURL: "http://127.0.0.1:5590",
		actionTimeout: 8000,
		trace: "retain-on-failure",
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
			command: `python3 -m http.server 5590 --bind 127.0.0.1 --directory ${quote(directory)}`,
			url: "http://127.0.0.1:5590/chat-page-native-http.html",
			reuseExistingServer: false,
			timeout: 30_000,
		},
	],
});
