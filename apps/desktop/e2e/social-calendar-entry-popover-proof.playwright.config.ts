import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5420/";

export default defineConfig({
	testDir: ".",
	testMatch: /social-calendar-entry-popover-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	timeout: 180_000,
	use: {
		actionTimeout: 12_000,
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1600, height: 1100 },
	},
	webServer: {
		command: "bun e2e/social-calendar-entry-popover-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
