import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5189";
const DESKTOP_ROOT = path.resolve(import.meta.dirname, "..");

export default defineConfig({
	testDir: ".",
	testMatch: /wallpaper-banner-surfaces-proof\.spec\.ts/,
	fullyParallel: false,
	timeout: 120_000,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.wallpaper-banner-surfaces-proof.config.ts",
		cwd: DESKTOP_ROOT,
		url: `${PROOF_URL}/wallpaper-banner-surfaces-proof.html`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
