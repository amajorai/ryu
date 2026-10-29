import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const hostPort = Number(process.env.RYU_TUITION_PROOF_PORT ?? 5496);
const baseURL = `http://127.0.0.1:${hostPort}/`;

export default defineConfig({
	testDir: ".",
	testMatch: /tuition-companion-proof\.tuition\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	outputDir: "/tmp/ryu-tuition-companion-playwright-results",
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		locale: "en-US",
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: "bun e2e/tuition-companion-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
