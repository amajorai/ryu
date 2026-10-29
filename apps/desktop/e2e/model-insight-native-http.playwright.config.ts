import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "model-insight-native-http.proof.ts",
	workers: 1,
	fullyParallel: false,
	timeout: 30000,
	use: { baseURL: "http://127.0.0.1:5610", trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			cwd: path.resolve(import.meta.dirname, ".."),
			command: "bun e2e/model-insight-native-http.host.ts",
			url: "http://127.0.0.1:5611/__proof/state",
			reuseExistingServer: false,
		},
		{
			cwd: path.resolve(import.meta.dirname, ".."),
			command:
				"bunx vite --config e2e/harness/vite.model-insight-native-http.config.ts",
			url: "http://127.0.0.1:5610/model-insight-native-http.html",
			reuseExistingServer: false,
		},
	],
});
