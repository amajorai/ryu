import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const STORY_URL = "http://127.0.0.1:5428/ugc-panel-interactions-proof.html";

export default defineConfig({
	testDir: ".",
	testMatch: /ugc-panel-interactions-proof\.spec\.ts$/,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: STORY_URL,
		trace: "on-first-retry",
		viewport: { width: 1440, height: 1000 },
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.ugc-panel-interactions-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: STORY_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
