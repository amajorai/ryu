// Playwright config for the plugin-runtime security certificate
// (`e2e/plugin-runtime.spec.ts`). Runs the cert page (`e2e/harness/`) in a real
// Chromium — the ONLY environment that enforces the load-bearing sandbox
// invariants (CSP `connect-src 'none'` egress blocking + null-origin
// `window.parent.document` isolation) that happy-dom/jsdom cannot.
//
// NOTE: headless Chromium cannot launch in the authoring sandbox; this config is
// authored + typechecked here (`bunx playwright test --list` parses it) and RUN in
// CI by the `plugin-runtime-cert` job (`.github/workflows/plugin-runtime-e2e.yml`).
//
// `testMatch` is scoped to `plugin-runtime.spec.ts` so the happy-dom wiring test
// under `e2e/wiring/` (a `bun test`, not a Playwright test) is never picked up.

import { defineConfig, devices } from "@playwright/test";

const HARNESS_URL = "http://localhost:5177/";

export default defineConfig({
	testDir: "./e2e",
	testMatch: /plugin-runtime\.spec\.ts$/,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: HARNESS_URL,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: "bunx vite --config e2e/harness/vite.harness.config.ts",
		url: HARNESS_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
