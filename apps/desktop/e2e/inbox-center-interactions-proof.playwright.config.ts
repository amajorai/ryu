import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5468/";

export default defineConfig({
	testDir: ".",
	testMatch: /inbox-center-interactions-proof\.spec\.ts$/u,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "line",
	use: {
		baseURL,
		viewport: { width: 1440, height: 1000 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"VITE_APP_BACKEND_URL=http://127.0.0.1:5468 bunx vite --config harness/vite.inbox-center-interactions-proof.config.ts",
		url: `${baseURL}inbox-center-interactions-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
