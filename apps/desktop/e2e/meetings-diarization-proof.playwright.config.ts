import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5202/";

export default defineConfig({
	testDir: ".",
	testMatch: /meetings-diarization-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: { baseURL, ...devices["Desktop Chrome"] },
	webServer: {
		command:
			"bunx vite --config harness/vite.meetings-diarization-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
