import { defineConfig, devices } from "@playwright/test";

// Runs the three existing Appearance browser proofs against their unchanged
// harnesses with an explicit Chromium binary and caller-owned output/cache
// directories. Each harness keeps its own port and its own project.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const viteCache =
	process.env.RYU_APPEARANCE_COVERAGE_VITE_CACHE ?? "/tmp/appearance-pw/vite";

const harnesses = [
	{
		name: "settings",
		port: 5209,
		spec: /appearance-settings-proof\.spec\.ts$/,
		timeout: 120_000,
	},
	{
		name: "consumer-effects",
		port: 5527,
		spec: /appearance-consumer-effects-proof\.spec\.ts$/,
		timeout: 90_000,
	},
	{
		name: "dialog-shell",
		port: 5237,
		spec: /settings-dialog-shell-proof\.spec\.ts$/,
		timeout: 120_000,
	},
] as const;

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	outputDir:
		process.env.RYU_APPEARANCE_COVERAGE_PW_OUTPUT ?? "/tmp/appearance-pw/out",
	projects: harnesses.map((harness) => ({
		name: harness.name,
		testMatch: harness.spec,
		timeout: harness.timeout,
		use: {
			...devices["Desktop Chrome"],
			acceptDownloads: true,
			baseURL: `http://127.0.0.1:${harness.port}/`,
			launchOptions: executablePath ? { executablePath } : {},
			trace: "off",
		},
	})),
	webServer: harnesses.map((harness) => ({
		command: "bunx vite --config harness/vite.appearance-coverage.config.ts",
		env: {
			RYU_APPEARANCE_COVERAGE_HARNESS: harness.name,
			RYU_APPEARANCE_COVERAGE_VITE_CACHE: viteCache,
		},
		url: `http://127.0.0.1:${harness.port}/`,
		reuseExistingServer: false,
		timeout: 120_000,
	})),
});
