import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5409/";

export default defineConfig({
	testDir: ".",
	testMatch: /video-studio-remaining-panels-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	timeout: 180_000,
	use: {
		actionTimeout: 12_000,
		acceptDownloads: true,
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1200 },
	},
	webServer: {
		command: "bun e2e/video-studio-remaining-panels-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
