import { defineConfig, devices } from "@playwright/test";

// Runs the existing Clips quick attach, Quests and Meetings settings browser
// proofs against their harnesses with an explicit Chromium binary and
// caller-owned output and cache directories. Screenshots the proofs take land
// under the output directory, never in the tracked proof evidence folders.
const output =
	process.env.RYU_CAPTURE_MEETINGS_OUTPUT ?? "/tmp/capture-meetings-pw/out";
const viteCache =
	process.env.RYU_CAPTURE_MEETINGS_VITE_CACHE ??
	"/tmp/capture-meetings-pw/vite";
process.env.RYU_PROOF_OUTPUT_ROOT ??= `${output}/proof`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

const harnesses = [
	{
		name: "clips-settings",
		port: 5238,
		ready: "",
		spec: /clips-quick-attach-settings-proof\.spec\.ts$/,
	},
	{
		name: "clips-destination",
		port: 5237,
		ready: "clips-quick-attach-destination-proof.html",
		spec: /clips-quick-attach-destination-proof\.spec\.ts$/,
	},
	{
		name: "quests-settings",
		port: 5286,
		ready: "quests-settings-proof.html",
		spec: /quests-settings-proof\.spec\.ts$/,
	},
	{
		name: "meetings-settings",
		port: 5573,
		ready: "",
		spec: /meetings-settings-proof\.spec\.ts$/,
	},
	{
		name: "meetings-diarization",
		port: 5202,
		ready: "",
		spec: /meetings-diarization-proof\.spec\.ts$/,
	},
] as const;

const selected = process.env.RYU_CAPTURE_MEETINGS_PROJECTS?.split(",");
const active = harnesses.filter(
	(harness) => !selected || selected.includes(harness.name)
);

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	reporter: "list",
	outputDir: `${output}/results`,
	projects: active.map((harness) => ({
		name: harness.name,
		testMatch: harness.spec,
		timeout: 120_000,
		use: {
			...devices["Desktop Chrome"],
			baseURL: `http://127.0.0.1:${harness.port}/`,
			launchOptions: executablePath ? { executablePath } : {},
			trace: "off",
		},
	})),
	webServer: active.map((harness) => ({
		command:
			"bunx vite --config harness/vite.capture-meetings-coverage.config.ts",
		cwd: import.meta.dirname,
		env: {
			RYU_CAPTURE_MEETINGS_HARNESS: harness.name,
			RYU_CAPTURE_MEETINGS_VITE_CACHE: viteCache,
		},
		url: `http://127.0.0.1:${harness.port}/${harness.ready}`,
		reuseExistingServer: false,
		timeout: 120_000,
	})),
});
