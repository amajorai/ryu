import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	testMatch: /composer-attachment-chips-proof\.spec\.ts$/,
	fullyParallel: false,
	forbidOnly: true,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5185",
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
			"bunx vite --config e2e/harness/vite.composer-attachment-chips-proof.config.ts --host 127.0.0.1",
		url: "http://127.0.0.1:5185/composer-attachment-chips-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
