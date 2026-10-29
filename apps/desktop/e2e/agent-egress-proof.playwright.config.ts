import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5384/";

export default defineConfig({
	workers: 1,
	outputDir: `${tmpdir()}/ryu-agent-egress-playwright-results`,
	testDir: ".",
	testMatch: /agent-egress-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { height: 1000, width: 1440 },
	},
	webServer: {
		command: "bunx vite --config harness/vite.agent-egress-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: `${baseURL}agent-egress-proof.html`,
	},
});
