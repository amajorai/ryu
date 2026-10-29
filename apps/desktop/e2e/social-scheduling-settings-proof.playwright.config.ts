import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5418/";

export default defineConfig({
	testDir: ".",
	testMatch: /social-scheduling-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	timeout: 180_000,
	use: {
		actionTimeout: 12_000,
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1600, height: 1500 },
	},
	webServer: {
		command: "bun e2e/social-scheduling-settings-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
