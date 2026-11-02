import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5184/";

export default defineConfig({
	testDir: ".",
	testMatch: /git-actions-stateful-proof\.spec\.ts$/,
	// The spec is split across files under the token limit; one worker keeps
	// them in the original order against the shared harness state.
	workers: 1,
	fullyParallel: false,
	reporter: "line",
	use: {
		...devices["Desktop Chrome"],
		baseURL: PROOF_URL,
	},
	webServer: {
		command: "bunx vite --config harness/vite.git-actions-proof.config.ts",
		url: `${PROOF_URL}git-actions-stateful-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
