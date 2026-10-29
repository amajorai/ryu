import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5187/";

export default defineConfig({
	testDir: ".",
	testMatch: /video-studio-behavior-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		actionTimeout: 10_000,
		acceptDownloads: true,
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "bun e2e/video-studio-behavior-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
