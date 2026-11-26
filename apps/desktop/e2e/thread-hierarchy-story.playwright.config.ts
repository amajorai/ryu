// Playwright config for `thread-hierarchy-story.spec.ts` (the breadcrumb) and
// `thread-tree-story.spec.ts` (the Sessions tree) on their own Vite server
// (`harness/vite.thread-hierarchy-story.config.ts`).
//
//   bunx playwright test --config e2e/thread-hierarchy-story.playwright.config.ts
//
// Set THREAD_HIERARCHY_SHOTS to a folder to keep the screenshots the spec takes
// (light and dark, desktop and phone width, English and Arabic).
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.RYU_THREAD_HIERARCHY_PORT ?? "5683");
const URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	expect: { timeout: 20_000 },
	testDir: ".",
	testMatch: ["thread-hierarchy-story.spec.ts", "thread-tree-story.spec.ts"],
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	timeout: 120_000,
	use: {
		...devices["Desktop Chrome"],
		baseURL: URL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.thread-hierarchy-story.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${URL}/thread-hierarchy-story.html`,
		reuseExistingServer: false,
		// A cold dependency scan can take minutes on a slow disk.
		timeout: 600_000,
	},
});
