import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5291/";
// Match the existing SettingsSync fixture ownership pattern. Strict proof runners
// provide an explicit invocation root; ordinary local runs retain its metadata.
const nativeControl =
	process.env.RYU_VOICE_OUTCOMES_DATA_ROOT ??
	mkdtempSync(path.join(tmpdir(), "ryu-voice-install-outcomes-"));

export default defineConfig({
	testDir: ".",
	testMatch: [
		"voice-settings-proof.spec.ts",
		"voice-install-native-http-outcomes.spec.ts",
	],
	workers: 1,
	forbidOnly: true,
	metadata: { voiceNativeControlRoot: nativeControl },
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: [
		{
			command: "node voice-install-native-http.host.mjs",
			cwd: import.meta.dirname,
			env: { RYU_VOICE_OUTCOMES_DATA_ROOT: nativeControl },
			url: "http://127.0.0.1:5866/health",
			reuseExistingServer: false,
			timeout: 120_000,
		},
		{
			command: "bunx vite --config harness/vite.voice-settings-proof.config.ts",
			url: `${baseURL}voice-settings-proof.html`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
	],
});
