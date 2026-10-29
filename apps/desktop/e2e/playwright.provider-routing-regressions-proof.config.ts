import path from "node:path";
import { defineConfig } from "@playwright/test";

const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
const desktop = path.resolve(import.meta.dirname, "..");
export default defineConfig({
	testDir: ".",
	testMatch: "provider-routing-regressions-proof.spec.ts",
	workers: 1,
	retries: 0,
	timeout: 600_000,
	reporter: "list",
	outputDir: "../../../docs/proof/provider-routing-regressions",
	use: {
		baseURL: "http://127.0.0.1:5317",
		viewport: { width: 1280, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: `${node} node_modules/vite/bin/vite.js --config e2e/harness/vite.provider-routing-regressions-proof.config.ts`,
		cwd: desktop,
		url: "http://127.0.0.1:5317/provider-routing-regressions-proof.html",
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
