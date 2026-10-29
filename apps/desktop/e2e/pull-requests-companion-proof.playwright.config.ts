import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const hostPort = Number(process.env.RYU_PULL_REQUESTS_PROOF_PORT ?? 5473);
const baseURL = `http://127.0.0.1:${hostPort}/`;

export default defineConfig({
	testDir: ".",
	testMatch: /pull-requests-companion-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	timeout: 60_000,
	use: {
		actionTimeout: 12_000,
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1500, height: 1100 },
	},
	webServer: {
		command: "bun e2e/pull-requests-companion-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 240_000,
	},
});
