import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "system-notifications-story.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60000,
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://127.0.0.1:5660",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: [
		{
			command: "bun e2e/system-notifications-story.host.ts",
			cwd: path.resolve(import.meta.dirname, ".."),
			url: "http://127.0.0.1:5661/__ready",
			reuseExistingServer: false,
			timeout: 30000,
		},
		{
			command:
				"bunx vite --config e2e/harness/vite.system-notifications-story.config.ts",
			cwd: path.resolve(import.meta.dirname, ".."),
			url: "http://127.0.0.1:5660/system-notifications-story.html",
			reuseExistingServer: false,
			timeout: 120000,
		},
	],
});
