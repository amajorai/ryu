import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5201/";

export default defineConfig({
	testDir: ".",
	testMatch: /streaming-mode-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.desktop-general-settings-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
	optimizeDeps: { entries: ["./desktop-general-settings-proof.html"] },
});
