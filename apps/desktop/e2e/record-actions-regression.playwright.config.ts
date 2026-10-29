import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
const baseURL = `http://127.0.0.1:${Number(process.env.RYU_RECORD_ACTIONS_PORT ?? 5525)}/`;
export default defineConfig({
	testDir: ".",
	testMatch: /record-actions-regression\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	outputDir: path.join(tmpdir(), "ryu-record-actions-regression-results"),
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		viewport: { width: 1440, height: 1050 },
		actionTimeout: 12_000,
	},
	webServer: {
		command: "bun e2e/record-companion-regression.host.ts",
		env: {
			RYU_RECORD_COMPANION_PORT: String(
				Number(process.env.RYU_RECORD_ACTIONS_PORT ?? 5525)
			),
		},
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 240_000,
	},
});
