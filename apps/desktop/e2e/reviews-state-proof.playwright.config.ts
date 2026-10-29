import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	timeout: 120_000,
	expect: { timeout: 30_000 },
	reporter: "list",
	testDir: ".",
	outputDir: "../test-results/reviews-state-proof",
	testMatch: /reviews-state-proof\.spec\.ts$/,
	use: { baseURL: "http://127.0.0.1:5249", trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command:
			"bunx vite build --config harness/vite.reviews-state-proof.config.ts && bunx vite preview --config harness/vite.reviews-state-proof.config.ts --host 127.0.0.1 --port 5249 --strictPort",
		reuseExistingServer: true,
		timeout: 120_000,
		url: "http://127.0.0.1:5249/reviews-state-proof.html",
	},
});
