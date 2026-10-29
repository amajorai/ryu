import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "license-reader-proof.spec.ts",
	workers: 1,
	fullyParallel: false,
	retries: 0,
	use: { baseURL: "http://127.0.0.1:33371", headless: true },
	webServer: {
		command:
			"bun run vite --config harness/license-reader-proof/vite.config.ts",
		url: "http://127.0.0.1:33371/index.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
