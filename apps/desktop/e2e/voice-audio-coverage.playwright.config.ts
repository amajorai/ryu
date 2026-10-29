import { mkdirSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// Runs the existing voice/audio/dictation settings browser proofs against
// their harnesses with an explicit Chromium binary and caller-owned output,
// cache and fixture directories. Screenshots the proofs take land under the
// output directory, never in the tracked proof evidence folders.
const output =
	process.env.RYU_VOICE_AUDIO_COVERAGE_OUTPUT ?? "/tmp/voice-audio-pw/out";
const viteCache =
	process.env.RYU_VOICE_AUDIO_COVERAGE_VITE_CACHE ?? "/tmp/voice-audio-pw/vite";
const nativeControl =
	process.env.RYU_VOICE_OUTCOMES_DATA_ROOT ??
	"/tmp/voice-audio-pw/native-control";
process.env.RYU_PROOF_OUTPUT_ROOT ??= `${output}/proof`;
mkdirSync(nativeControl, { recursive: true });
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

const harnesses = [
	{
		name: "voice-settings",
		port: 5291,
		ready: "voice-settings-proof.html",
		spec: /(voice-settings-proof|voice-install-native-http-outcomes)\.spec\.ts$/,
	},
	{
		name: "dictation",
		port: 5394,
		ready: "",
		spec: /dictation-settings-proof\.spec\.ts$/,
	},
	{
		name: "audio-devices",
		port: 5261,
		ready: "",
		spec: /audio-devices-settings-proof\.spec\.ts$/,
	},
] as const;

const selected = process.env.RYU_VOICE_AUDIO_COVERAGE_PROJECTS?.split(",");
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
	metadata: { voiceNativeControlRoot: nativeControl },
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
	webServer: [
		...(active.some((harness) => harness.name === "voice-settings")
			? [
					{
						command: "node voice-install-native-http.host.mjs",
						cwd: import.meta.dirname,
						env: { RYU_VOICE_OUTCOMES_DATA_ROOT: nativeControl },
						url: "http://127.0.0.1:5866/health",
						reuseExistingServer: false,
						timeout: 120_000,
					},
				]
			: []),
		...active.map((harness) => ({
			command: "bunx vite --config harness/vite.voice-audio-coverage.config.ts",
			cwd: import.meta.dirname,
			env: {
				RYU_VOICE_AUDIO_COVERAGE_HARNESS: harness.name,
				RYU_VOICE_AUDIO_COVERAGE_VITE_CACHE: viteCache,
			},
			url: `http://127.0.0.1:${harness.port}/${harness.ready}`,
			reuseExistingServer: false,
			timeout: 120_000,
		})),
	],
});
