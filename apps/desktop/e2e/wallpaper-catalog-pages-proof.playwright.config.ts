import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5187";
const externalHarness = process.env.RYU_E2E_EXTERNAL_HARNESS === "1";
const DESKTOP_ROOT = path.resolve(import.meta.dirname, "..");

export default defineConfig({
	testDir: ".",
	testMatch: /wallpaper-catalog-pages-proof\.spec\.ts/,
	fullyParallel: false,
	timeout: 120_000,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
		...devices["Desktop Chrome"],
	},
	webServer: externalHarness
		? undefined
		: {
				command:
					"bunx vite --config e2e/harness/vite.wallpaper-catalog-pages-proof.config.ts",
				cwd: DESKTOP_ROOT,
				url: `${PROOF_URL}/wallpaper-catalog-pages-proof.html`,
				reuseExistingServer: true,
				timeout: 120_000,
			},
});
