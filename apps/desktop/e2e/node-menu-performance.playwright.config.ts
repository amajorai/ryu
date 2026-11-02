import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /node-menu-performance\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	outputDir: path.join(tmpdir(), "ryu-node-menu-performance-results"),
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5214",
		viewport: { width: 1200, height: 900 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: "bunx vite --config harness/vite.node-menu-performance.config.ts",
		url: "http://127.0.0.1:5214/node-selector-status-story.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
