import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "gateway-cli-setup-proof.spec.ts",
	use: {
		baseURL: "http://127.0.0.1:5298",
		viewport: { width: 1280, height: 900 },
	},
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.gateway-cli-setup-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:5298/gateway-cli-setup-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
