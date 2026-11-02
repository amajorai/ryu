import path from "node:path";
import { defineConfig } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const desktop = path.resolve(import.meta.dirname, "..");
export default defineConfig({
	testDir: ".",
	testMatch: "provider-ui-contract-repair.spec.ts",
	workers: 1,
	retries: 0,
	timeout: 600_000,
	reporter: "list",
	outputDir: proofEvidencePath("provider-ui-contract-repair/results"),
	use: {
		baseURL: "http://127.0.0.1:5332",
		viewport: { width: 1440, height: 1100 },
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.provider-ui-contract-repair.config.ts",
		cwd: desktop,
		url: "http://127.0.0.1:5332/provider-ui-contract-repair.html",
		reuseExistingServer: true,
		timeout: 180_000,
	},
});
