import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { proofBuildHeapEnv } from "./proof-build-heap.ts";

// The spec writes its evidence to a fresh absolute directory; give it one
// under the temp dir unless the caller named one. Workers inherit it.
const proofDir =
	process.env.RYU_OPTIMIZER_AGENT_PROOF_DIR ??
	mkdtempSync(path.join(tmpdir(), "ryu-optimizer-agent-route-proof-"));
process.env.RYU_OPTIMIZER_AGENT_PROOF_DIR = proofDir;

const baseURL = "http://127.0.0.1:5496";
export default defineConfig({
	testDir: ".",
	testMatch: /optimizer-agent-route-proof\.spec\.ts$/,
	workers: 1,
	fullyParallel: false,
	retries: 0,
	outputDir: path.join(proofDir, "playwright"),
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1100 },
		trace: "retain-on-failure",
	},
	webServer: {
		// Build first: preview serves RYU_OPTIMIZER_AGENT_BUILD_DIR (or its temp
		// default), which nothing else produces.
		command:
			"bun x vite build --config harness/vite.optimizer-agent-route-proof.config.ts && bun x vite preview --config harness/vite.optimizer-agent-route-proof.config.ts --host 127.0.0.1 --port 5496 --strictPort",
		env: proofBuildHeapEnv(8192),
		url: `${baseURL}/optimizer-agent-route-proof.html`,
		reuseExistingServer: false,
		timeout: 300_000,
	},
});
