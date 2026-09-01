import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /org-seat-members-proof\.spec\.ts$/,
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://127.0.0.1:5199/",
	},
	webServer: {
		command: "bunx vite --config harness/vite.org-seat-members-proof.config.ts",
		reuseExistingServer: false,
		timeout: 120_000,
		url: "http://127.0.0.1:5199/org-seat-members-proof.html",
	},
});
