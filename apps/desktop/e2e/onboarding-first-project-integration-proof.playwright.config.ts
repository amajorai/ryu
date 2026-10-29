import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const baseURL = "http://127.0.0.1:5299/";

export default defineConfig({
	testDir: ".",
	testMatch: "onboarding-first-project-integration-proof.spec.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: true,
	retries: 0,
	// This single journey loads the unbundled Vite dev harness (~600 modules)
	// four times: the first visit plus three deliberate reloads that prove the
	// persisted phase. On a contended 4-CPU CI runner those loads alone take
	// ~35s (cold ~15s, warm ~6s each) while every in-page step settles in under
	// a second, so the default 30s budget cannot cover the journey.
	timeout: 90_000,
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
		"test-results/onboarding-first-project-integration-proof"
	),
});
