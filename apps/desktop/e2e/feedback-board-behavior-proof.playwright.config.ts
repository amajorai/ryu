import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5198/";

export default defineConfig({
	testDir: ".",
	testMatch: /feedback-board-behavior-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		actionTimeout: 10_000,
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "bun e2e/feedback-board-behavior-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
