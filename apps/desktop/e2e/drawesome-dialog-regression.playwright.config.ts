import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
const baseURL = `http://127.0.0.1:${Number(process.env.RYU_DRAWESOME_DIALOG_PORT ?? 5533)}/`;
export default defineConfig({
	testDir: ".",
	testMatch: /drawesome-dialog-regression\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	outputDir: path.join(tmpdir(), "ryu-drawesome-dialog-regression-results"),
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		viewport: { width: 1440, height: 1050 },
		actionTimeout: 12_000,
	},
	webServer: {
		command: "bun e2e/drawesome-dialog-regression.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 240_000,
	},
});
