import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5231";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
	testDir: ".",
	testMatch: /shadow-subscription-browser\.spec\.ts$/,
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	retries: 0,
	reporter: "list",
	outputDir:
		process.env.RYU_SHADOW_SUBSCRIPTION_PW_OUTPUT ??
		"/tmp/shadow-subscription-pw/out",
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		launchOptions: executablePath ? { executablePath } : {},
		trace: "off",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.shadow-subscription-browser.config.ts",
		url: `${baseURL}/shadow-computer-use-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
