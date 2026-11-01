import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /prompt-studio(-import|-runs)?-proof\.spec\.ts$/,
	fullyParallel: false,
	use: { baseURL: "http://127.0.0.1:5188/" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "bunx vite --config harness/vite.prompt-studio-proof.config.ts",
		url: "http://127.0.0.1:5188/prompt-studio-proof.html",
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
