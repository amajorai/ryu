import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5496";
export default defineConfig({
	testDir: ".",
	testMatch: /optimizer-agent-route-proof\.spec\.ts$/,
	workers: 1,
	fullyParallel: false,
	retries: 0,
	outputDir: process.env.RYU_OPTIMIZER_AGENT_PROOF_DIR
		? `${process.env.RYU_OPTIMIZER_AGENT_PROOF_DIR}/playwright`
		: `${tmpdir()}/ryu-optimizer-agent-route-results`,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1100 },
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bun x vite preview --config harness/vite.optimizer-agent-route-proof.config.ts --host 127.0.0.1 --port 5496 --strictPort",
		url: `${baseURL}/optimizer-agent-route-proof.html`,
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
