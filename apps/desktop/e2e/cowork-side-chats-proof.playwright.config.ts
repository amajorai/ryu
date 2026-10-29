import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /cowork-(?:side-chats|pinned-controls|inventory)-proof\.spec\.ts$/,
	timeout: 90_000,
	outputDir: `${tmpdir()}/ryu-cowork-side-chats-playwright-results`,
	workers: 1,
	retries: 0,
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://127.0.0.1:5414/",
		trace: "off",
	},
	webServer: {
		command:
			"node ../node_modules/vite/bin/vite.js --config harness/vite.cowork-side-chats-proof.config.ts",
		url: "http://127.0.0.1:5414/cowork-side-chats-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
