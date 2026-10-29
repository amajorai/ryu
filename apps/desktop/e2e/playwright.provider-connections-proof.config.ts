import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "provider-connections-proof.spec.ts",
	use: {
		baseURL: "http://127.0.0.1:5187",
		viewport: { width: 1280, height: 900 },
	},
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.provider-connections-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:5187/provider-connections-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
