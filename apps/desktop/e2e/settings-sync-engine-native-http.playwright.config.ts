import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const desktop = path.resolve(import.meta.dirname, "..");
const control =
	process.env.SYNC_PROOF_CONTROL_ROOT ??
	mkdtempSync(path.join(tmpdir(), "ryu-settings-sync-engine-proof-"));
const fixtureEnvironment = { SYNC_PROOF_CONTROL_ROOT: control };

export default defineConfig({
	globalSetup: path.join(
		import.meta.dirname,
		"settings-sync-engine-native-http.setup.ts"
	),
	metadata: { proofControl: control },
	testDir: ".",
	testMatch: "settings-sync-engine-native-http.spec.ts",
	workers: 1,
	retries: 0,
	fullyParallel: false,
	timeout: 30_000,
	use: { baseURL: "http://127.0.0.1:5606", trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			command: "bun e2e/settings-sync-engine-native-http.host.ts",
			cwd: desktop,
			env: fixtureEnvironment,
			url: "http://127.0.0.1:5607/proof/health",
			reuseExistingServer: false,
		},
		{
			command:
				"node node_modules/vite/bin/vite.js --config e2e/harness/vite.settings-sync-engine-proof.config.ts",
			cwd: desktop,
			env: fixtureEnvironment,
			url: "http://127.0.0.1:5606/settings-sync-engine-proof.html",
			reuseExistingServer: false,
		},
	],
});
