import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { workflowsProofBuildCommand } from "./workflows-proof-build.ts";

const baseURL = "http://127.0.0.1:5283/";

export default defineConfig({
	testDir: ".",
	testMatch: /workflows-control-node-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	use: {
		actionTimeout: 10_000,
		baseURL,
		viewport: { width: 1440, height: 1080 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: workflowsProofBuildCommand(
			"control-coverage",
			"workflows-control-node-proof.host.ts"
		),
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
