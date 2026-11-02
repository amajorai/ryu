import { defineConfig, devices } from "@playwright/test";

const proofUrl = "http://127.0.0.1:5249/";

export default defineConfig({
	testDir: ".",
	testMatch: /cloud-environments-proof\.spec\.ts$/,
	// The spec is split across files under the token limit; one worker keeps
	// them in the original order against the shared harness state.
	workers: 1,
	fullyParallel: false,
	timeout: 360_000,
	expect: { timeout: 60_000 },
	retries: 0,
	reporter: "line",
	use: {
		...devices["Desktop Chrome"],
		baseURL: proofUrl,
		trace: "retain-on-failure",
	},
	webServer: {
		// Build first: preview serves target/cloud-environments-proof-build, which
		// nothing else produces, so a fresh checkout would otherwise 404.
		command:
			"node ../node_modules/vite/bin/vite.js build --config harness/vite.cloud-environments-proof.config.ts && node ../node_modules/vite/bin/vite.js preview --config harness/vite.cloud-environments-proof.config.ts",
		url: `${proofUrl}cloud-environments-proof.html`,
		reuseExistingServer: false,
		timeout: 300_000,
	},
});
