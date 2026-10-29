import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const proofPort = process.env.RYU_KILL_SWITCH_PROOF_PORT ?? "5264";

export default defineConfig({
	timeout: 120_000,
	testDir: import.meta.dirname,
	testMatch: "kill-switch-proof.spec.ts",
	outputDir: path.resolve(
		import.meta.dirname,
		"../../../docs/proof/kill-switch"
	),
	use: {
		...devices["Desktop Chrome"],
		baseURL: `http://127.0.0.1:${proofPort}`,
		trace: process.env.RYU_KILL_SWITCH_PROOF_URL ? "off" : "retain-on-failure",
	},
	webServer:
		process.env.RYU_KILL_SWITCH_PROOF_EXTERNAL_SERVER === "1"
			? undefined
			: {
					command:
						"bunx vite --config e2e/harness/vite.kill-switch-proof.config.ts",
					cwd: path.resolve(import.meta.dirname, ".."),
					reuseExistingServer: true,
					url: `http://127.0.0.1:${proofPort}/kill-switch-proof.html`,
				},
});
