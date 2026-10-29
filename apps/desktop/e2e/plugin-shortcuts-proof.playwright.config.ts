import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "plugin-shortcuts-proof.spec.ts",
	workers: 1,
	fullyParallel: false,
	retries: 0,
	// Dev-server route only. The spec's catch-all origin guard (page.route)
	// intercepts every request and disables the HTTP cache, so each navigation
	// re-fetches ~3,400 unbundled modules through route.continue (~50 s each on
	// a loaded 4-CPU host). The malformed-document case navigates seven times
	// (measured 348 s). The static config keeps 60 s for its bundled build.
	timeout: 900_000,
	use: {
		baseURL: "http://127.0.0.1:33368",
		headless: true,
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: [
		{
			command: "bun harness/plugin-shortcuts-proof/host.ts",
			url: "http://127.0.0.1:33367/health",
			reuseExistingServer: false,
			timeout: 30_000,
		},
		{
			command:
				"bun run vite --config harness/plugin-shortcuts-proof/vite.config.ts",
			url: "http://127.0.0.1:33368/index.html",
			reuseExistingServer: false,
			timeout: 120_000,
		},
	],
});
