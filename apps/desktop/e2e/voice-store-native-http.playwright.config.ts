import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5291/";
const nativeControl =
	process.env.RYU_VOICE_OUTCOMES_DATA_ROOT ??
	mkdtempSync(path.join(tmpdir(), "ryu-voice-store-outcomes-"));

export default defineConfig({
	testDir: ".",
	testMatch: "voice-store-native-http-outcomes.spec.ts",
	workers: 1,
	forbidOnly: true,
	retries: 0,
	fullyParallel: false,
	timeout: 60_000,
	metadata: { voiceNativeControlRoot: nativeControl },
	use: { baseURL, ...devices["Desktop Chrome"] },
	webServer: [
		{
			command: "node voice-store-native-http.host.mjs",
			cwd: import.meta.dirname,
			env: { RYU_VOICE_OUTCOMES_DATA_ROOT: nativeControl },
			url: "http://127.0.0.1:5866/health",
			reuseExistingServer: false,
			timeout: 120_000,
		},
		{
			command:
				"bunx vite --config harness/vite.voice-store-native-http.config.ts",
			url: `${baseURL}voice-store-native-http-outcomes.html`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
	],
});
