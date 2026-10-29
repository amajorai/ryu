import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "agent-edit-loading-proof.spec.ts",
	workers: 1,
	timeout: 90_000,
	expect: { timeout: 30_000 },
	use: {
		baseURL: "http://127.0.0.1:5388",
		browserName: "chromium",
		channel: process.platform === "win32" ? "msedge" : undefined,
		viewport: { width: 1600, height: 1100 },
	},
	webServer: {
		command:
			"bun x vite --config e2e/harness/vite.agent-edit-loading-proof.config.ts --port 5388",
		cwd: path.resolve(import.meta.dirname, "../.."),
		url: "http://127.0.0.1:5388/agent-edit-loading-proof.html",
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		env: {
			NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=8192",
		},
	},
});
