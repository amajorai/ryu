import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5298/";

export default defineConfig({
	fullyParallel: false,
	outputDir: `${tmpdir()}/ryu-gateway-evals-health-playwright-results`,
	retries: 0,
	testDir: ".",
	testMatch: /gateway-evals-health-proof\.spec\.ts$/,
	use: { baseURL, ...devices["Desktop Chrome"] },
	webServer: {
		command:
			"bunx vite --config harness/vite.gateway-evals-health-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
