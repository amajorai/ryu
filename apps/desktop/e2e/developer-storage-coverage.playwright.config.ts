import { defineConfig, devices } from "@playwright/test";

// Runs the existing Developer, Danger Zone and Storage browser proofs against
// their unchanged harnesses with an explicit Chromium binary and caller-owned
// output and cache directories. Each harness keeps its own port and project.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const viteCache =
	process.env.RYU_DEVELOPER_STORAGE_VITE_CACHE ??
	"/tmp/developer-storage-pw/vite";
const only = process.env.RYU_DEVELOPER_STORAGE_ONLY;
// The proofs refresh committed evidence screenshots by default; a coverage run
// writes them to scratch so the tracked proof ledger stays untouched.
process.env.RYU_PROOF_EVIDENCE_DIR ??= "/tmp/developer-storage-pw/evidence";

const harnesses = [
	{
		name: "danger",
		port: 5255,
		spec: /desktop-danger-zone-proof\.spec\.ts$/,
	},
	{
		name: "developer",
		port: 5224,
		spec: /developer-account-sessions-settings-proof\.spec\.ts$/,
	},
	{
		name: "storage",
		port: 5247,
		spec: /gateway-storage-settings-proof\.spec\.ts$/,
	},
].filter((harness) => !only || only.split(",").includes(harness.name));

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	outputDir:
		process.env.RYU_DEVELOPER_STORAGE_PW_OUTPUT ??
		"/tmp/developer-storage-pw/out",
	projects: harnesses.map((harness) => ({
		name: harness.name,
		testMatch: harness.spec,
		timeout: 120_000,
		use: {
			...devices["Desktop Chrome"],
			acceptDownloads: true,
			baseURL: `http://127.0.0.1:${harness.port}/`,
			launchOptions: executablePath ? { executablePath } : {},
			trace: "off",
		},
	})),
	webServer: harnesses.map((harness) => ({
		command:
			"bunx vite --config harness/vite.developer-storage-coverage.config.ts",
		env: {
			RYU_DEVELOPER_STORAGE_HARNESS: harness.name,
			RYU_DEVELOPER_STORAGE_VITE_CACHE: viteCache,
		},
		url: `http://127.0.0.1:${harness.port}/`,
		reuseExistingServer: false,
		timeout: 120_000,
	})),
});
