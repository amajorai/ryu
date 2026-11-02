import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5204/";

export default defineConfig({
	testDir: ".",
	testMatch: /agent-version-history-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	// The proof drives the real AgentEditPage graph on an unbundled dev server.
	// Under parallel load a reload of those few hundred modules alone took
	// longer than the 30 s default, and the remounted editor more than 5 s.
	timeout: 90_000,
	expect: { timeout: 15_000 },
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"bunx vite --config harness/vite.agent-version-history-proof.config.ts",
		url: PROOF_URL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
