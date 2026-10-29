import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5187/";

export default defineConfig({
	testDir: ".",
	testMatch: /video-studio-avatar-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	use: {
		actionTimeout: 10_000,
		acceptDownloads: true,
		baseURL,
		viewport: { width: 1440, height: 1200 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "bun e2e/video-studio-avatar-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
