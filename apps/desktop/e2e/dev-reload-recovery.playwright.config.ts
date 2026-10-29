import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "dev-reload-recovery.spec.ts",
	workers: 1,
	timeout: 90_000,
	expect: { timeout: 15_000 },
	retries: 0,
	outputDir: "../../../docs/proof/dev-reload-recovery/results",
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://127.0.0.1:5198",
		viewport: { width: 1280, height: 800 },
		trace: "retain-on-failure",
	},
	webServer: {
		cwd: path.resolve(import.meta.dirname, ".."),
		command:
			"bunx vite --config e2e/harness/vite.dev-reload-recovery.config.ts",
		url: "http://127.0.0.1:5198/dev-reload-recovery-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
