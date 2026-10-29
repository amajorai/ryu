import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:6143/";

export default defineConfig({
	testDir: ".",
	testMatch: /onboarding-migration-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "list",
	use: {
		baseURL,
		viewport: { width: 1440, height: 1000 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bun x vite --config harness/vite.onboarding-migration-proof.config.ts --host 127.0.0.1 --port 6143 --strictPort",
		url: `${baseURL}onboarding-migration-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
