import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "sdk-accounts-proof.spec.ts",
	timeout: 90_000,
	use: {
		baseURL: "http://127.0.0.1:5198",
		viewport: { width: 1280, height: 1000 },
	},
	webServer: {
		command: "bunx vite --config e2e/harness/vite.sdk-accounts-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:5198/sdk-accounts-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
