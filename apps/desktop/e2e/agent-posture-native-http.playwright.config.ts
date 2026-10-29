import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "agent-posture-native-http.spec.ts",
	workers: 1,
	retries: 0,
	timeout: 45_000,
	use: { baseURL: "http://127.0.0.1:5730", trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			command: "bun e2e/agent-posture-native-http.host.ts",
			url: "http://127.0.0.1:5731/__state",
			cwd: path.resolve(import.meta.dirname, ".."),
			reuseExistingServer: false,
		},
		{
			command: "bun e2e/agent-posture-native-http.preview.ts",
			cwd: path.resolve(import.meta.dirname, ".."),
			url: "http://127.0.0.1:5730/agent-posture-native-http.html",
			timeout: 180_000,
			reuseExistingServer: false,
		},
	],
});
