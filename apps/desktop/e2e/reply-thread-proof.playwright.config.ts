import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5177/";

export default defineConfig({
	testDir: ".",
	testMatch: /reply-thread-proof\.spec\.ts/,
	fullyParallel: false,
	reporter: "list",
	use: {
		baseURL,
		trace: "on-first-retry",
	},
	webServer: {
		command: "bunx vite --config e2e/harness/vite.harness.config.ts",
		// The config path is relative to apps/desktop, not to this e2e/ directory
		// (Playwright's default webServer cwd).
		cwd: path.resolve(import.meta.dirname, ".."),
		reuseExistingServer: true,
		timeout: 120_000,
		url: baseURL,
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
