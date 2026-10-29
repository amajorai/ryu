import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: import.meta.dirname,
	testMatch:
		/(chat-row-menus-story|chat-row-selection-story|agent-conversation-branch-proof|keyboard-shortcuts-search-proof)\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	reporter: [["list"]],
	use: {
		baseURL: "http://127.0.0.1:5182",
		...devices["Desktop Chrome"],
		video: "off",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.chat-sidebar-suite.config.ts --host 127.0.0.1 --port 5182",
		url: "http://127.0.0.1:5182/chat-row-menus-story.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
