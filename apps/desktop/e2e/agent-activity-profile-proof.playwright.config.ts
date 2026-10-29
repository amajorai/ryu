import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: path.resolve(import.meta.dirname),
	testMatch: "agent-activity-profile-proof.spec.ts",
	use: {
		baseURL: "http://127.0.0.1:5207",
		trace: "on-first-retry",
		viewport: { width: 1440, height: 900 },
	},
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.agent-activity-profile-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:5207/agent-activity-profile-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
