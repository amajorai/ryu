import { defineConfig, devices } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const PROOF_URL = "http://127.0.0.1:5223/";

export default defineConfig({
	testDir: ".",
	outputDir: proofEvidencePath("git-credit/playwright-results"),
	testMatch: /git-credit-proof\.spec\.ts$/,
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
		command: "bunx vite --config harness/vite.git-credit-proof.config.ts",
		url: `${PROOF_URL}git-credit-proof.html`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
