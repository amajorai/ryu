import { defineConfig, devices } from "@playwright/test";

// Real-Chromium proof for the shared CopyableId: keyboard activation and the
// hover/focus blur reveal. Output and the Vite cache stay under /tmp.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const baseURL = "http://127.0.0.1:5871/";

export default defineConfig({
	testDir: ".",
	testMatch: /unswept-a-copyable-id\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	outputDir: process.env.RYU_UNSWEPT_A_PW_OUTPUT ?? "/tmp/unswept-a-pw/out",
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		launchOptions: executablePath ? { executablePath } : {},
		permissions: ["clipboard-read", "clipboard-write"],
		trace: "off",
	},
	webServer: {
		command: "bunx vite --config harness/vite.unswept-a-copyable-id.config.ts",
		url: `${baseURL}unswept-a-copyable-id.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
