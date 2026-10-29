import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5218/";

export default defineConfig({
	testDir: ".",
	outputDir: "../../../docs/proof/worktree-settings/playwright-results",
	testMatch: /worktree-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	timeout: 600_000,
	expect: { timeout: 60_000 },
	retries: 0,
	reporter: "line",
	use: {
		...devices["Desktop Chrome"],
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.worktree-settings-proof.config.ts",
		url: `${PROOF_URL}worktree-settings-proof.html`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
