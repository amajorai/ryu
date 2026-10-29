import { defineConfig, devices } from "@playwright/test";

// Settings dialog proofs for the unswept-b item, all on one Vite server of
// their own (port 5293) with an explicit Chromium binary and output/cache
// under /tmp:
//   - `shell`: the existing settings-dialog shell spec, unchanged story;
//   - `search-and-lazy`: search, navigation, reveal, keyboard and the lazy
//     entry point against the unswept-b story;
//   - `startup-slow-import`: only the existing startup-performance case that
//     closes during a slow import. That spec's other settings case writes a
//     tracked proof image under docs/, so it is deliberately not selected.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const baseURL = "http://127.0.0.1:5293/";
const browser = {
	...devices["Desktop Chrome"],
	baseURL,
	launchOptions: executablePath ? { executablePath } : {},
	trace: "off" as const,
};

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	timeout: 120_000,
	outputDir: process.env.RYU_UNSWEPT_B_PW_OUTPUT ?? "/tmp/unswept-b-pw/out",
	projects: [
		{
			name: "shell",
			testMatch: /settings-dialog-shell-proof\.spec\.ts$/,
			use: browser,
		},
		{
			name: "search-and-lazy",
			testMatch: /unswept-b-settings\.spec\.ts$/,
			use: browser,
		},
		{
			name: "startup-slow-import",
			testMatch: /startup-performance-proof\.spec\.ts$/,
			grep: /closing during a slow initial settings import/,
			use: { ...browser, viewport: { height: 900, width: 1440 } },
		},
	],
	webServer: {
		command: "bunx vite --config harness/vite.unswept-b-settings.config.ts",
		url: `${baseURL}unswept-b-settings.html`,
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
