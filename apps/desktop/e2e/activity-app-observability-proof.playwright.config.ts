import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: path.resolve(import.meta.dirname),
	testMatch: [
		"activity-app-observability-proof.spec.ts",
		"part*-activity-app-observability-proof.spec.ts",
	],
	// The spec is split across files under the token limit; one worker keeps
	// them in the original order against the shared harness state.
	workers: 1,
	use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5190" },
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.activity-app-observability-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		reuseExistingServer: true,
		url: "http://127.0.0.1:5190/activity-app-observability-proof.html",
	},
});
