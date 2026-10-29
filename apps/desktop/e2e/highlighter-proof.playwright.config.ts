import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "highlighter-proof.spec.ts",
	workers: 1,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5493",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				launchOptions: {
					executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
				},
				viewport: { width: 1200, height: 850 },
			},
		},
	],
	webServer: {
		command: "bun x vite --config harness/vite.highlighter-proof.config.ts",
		url: "http://127.0.0.1:5493/highlighter-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
