import { defineConfig, devices } from "@playwright/test";

const STORY_URL = "http://127.0.0.1:5198/";

export default defineConfig({
	testDir: ".",
	testMatch: /share-conversation-toolbar-entry\.proof\.ts$/,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: STORY_URL,
		trace: "on-first-retry",
		viewport: { width: 1280, height: 900 },
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1280, height: 1000 },
			},
		},
	],
	webServer: {
		command:
			"bunx vite --config harness/vite.share-conversation-toolbar-entry.config.ts",
		url: STORY_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
