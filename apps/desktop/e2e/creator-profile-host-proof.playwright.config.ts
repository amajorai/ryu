import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /creator-profile-host-proof\.spec\.ts$/,
	fullyParallel: false,
	use: { baseURL: "http://localhost:5197", trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command:
			"bunx vite --config harness/vite.creator-profile-host-proof.config.ts",
		url: "http://localhost:5197/creator-profile-host-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
