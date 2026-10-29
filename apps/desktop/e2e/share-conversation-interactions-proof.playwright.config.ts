import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const proofUrl = "http://127.0.0.1:5388/";
const viteConfig = path.resolve(
	desktopRoot,
	"e2e/harness/vite.share-conversation-story.config.ts"
);

export default defineConfig({
	testDir: ".",
	testMatch: /share-conversation-story\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	reporter: "list",
	use: {
		baseURL: proofUrl,
		trace: "retain-on-failure",
		viewport: { width: 1120, height: 900 },
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: `node node_modules/vite/bin/vite.js --config ${viteConfig}`,
		cwd: desktopRoot,
		url: `${proofUrl}share-conversation-story.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
