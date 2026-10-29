import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const hostPort = Number(process.env.RYU_SITES_CAPABILITY_PORT ?? 5531);
const baseURL = `http://127.0.0.1:${hostPort}/`;

export default defineConfig({
	testDir: ".",
	testMatch: /sites-capability-regression\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	timeout: 60_000,
	outputDir: "/tmp/ryu-sites-capability-regression-results",
	use: {
		actionTimeout: 12_000,
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1050 },
	},
	webServer: {
		command: "bun e2e/sites-capability-regression.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 240_000,
	},
});
