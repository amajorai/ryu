import path from "node:path";
import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:5189";

export default defineConfig({
	testDir: ".",
	testMatch: "provider-account-switch-proof.spec.ts",
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "list",
	use: {
		baseURL,
		viewport: { width: 1280, height: 900 },
	},
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.provider-account-switch-proof.config.ts --host 127.0.0.1 --port 5189 --strictPort",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}/provider-account-switch-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
