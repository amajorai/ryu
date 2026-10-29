import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5328/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-vault-secrets-playwright-results`,
	testDir: ".",
	testMatch: /vault-secrets-interactions-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
		viewport: { width: 1280, height: 960 },
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: "bun run vite --config harness/vite.vault-secrets-proof.config.ts",
		url: PROOF_URL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
