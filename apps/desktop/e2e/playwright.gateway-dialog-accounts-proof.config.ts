import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "gateway-dialog-accounts-proof.spec.ts",
	timeout: 90_000,
	use: {
		baseURL: "http://127.0.0.1:5199",
		viewport: { width: 1440, height: 1000 },
	},
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.gateway-dialog-accounts-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:5199/gateway-dialog-accounts-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
