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
// `testMatch` is `*.spec.ts` so the isolated-component browser specs
// (`overflow-story.spec.ts`, `command-palette.spec.ts`) run alongside the
// plugin-runtime cert, while the happy-dom wiring test under `e2e/wiring/`
// (`*.test.tsx`, a `bun test`, not a Playwright test) is still never picked up.

import { defineConfig, devices } from "@playwright/test";

const HARNESS_PORT = Number(process.env.RYU_E2E_PORT ?? "5177");
const HARNESS_URL = `http://127.0.0.1:${HARNESS_PORT}/`;
const HARNESS_READY_URL = `${HARNESS_URL}command-palette-story.html`;

export default defineConfig({
	testDir: "./e2e",
	testMatch: /\.spec\.ts$/,
	// `*.live.spec.ts` needs a running Core and is opt-in (`bun run test:e2e:live`,
	// which sets RYU_E2E_LIVE). Excluded from the default run for a mechanical
	// reason, not a policy one: its story imports the whole download-center graph,
	// and vite compiling that on demand starves the other specs sharing this dev
	// server past their 30s timeout. CI has no Core either way.
	testIgnore: process.env.RYU_E2E_LIVE ? undefined : /\.live\.spec\.ts$/,
	fullyParallel: true,
	// The shared Vite harness compiles its module graph lazily. Serial CI keeps a
	// cold first navigation from starving sibling stories while they start together.
	workers: process.env.CI ? 1 : undefined,
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
	webServer:
		process.env.RYU_E2E_EXTERNAL_HARNESS === "1"
			? undefined
			: {
					command:
						"node node_modules/vite/bin/vite.js --config e2e/harness/vite.harness.config.ts",
					url: HARNESS_READY_URL,
					reuseExistingServer: !process.env.CI,
					timeout: 120_000,
				},
});
