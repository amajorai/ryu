import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const baseURL = "http://127.0.0.1:5299/";

export default defineConfig({
	testDir: ".",
	testMatch: "onboarding-privacy-step-proof.spec.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: true,
	retries: 0,
	reporter: "list",
	use: { ...devices["Desktop Chrome"], baseURL, trace: "retain-on-failure" },
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.onboarding-first-project-integration-proof.config.ts",
		cwd: desktopRoot,
		url: `${baseURL}onboarding-first-project-integration-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
	outputDir: path.join(
		desktopRoot,
		"test-results/onboarding-privacy-step-proof"
	),
});
