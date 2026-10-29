import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const STORY_URL = "http://127.0.0.1:5186/";

export default defineConfig({
	testDir: ".",
	testMatch: /stats-plugin-proof\.spec\.ts$/,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: STORY_URL,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.stats-plugin-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: STORY_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
