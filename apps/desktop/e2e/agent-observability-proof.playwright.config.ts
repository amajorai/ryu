import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: path.resolve(import.meta.dirname),
	testMatch: /agent-observability-proof(\.retry)?\.spec\.ts$/,
	use: {
		baseURL: "http://127.0.0.1:5189",
		trace: "on-first-retry",
	},
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.agent-observability-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:5189/agent-observability-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
