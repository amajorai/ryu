// Warms the project-settings harness's Vite dev server once before its specs run.
//
// The project instructions field is the shared Plate `MarkdownEditor`, which
// `src/components/editor/MarkdownEditor.tsx` lazy-loads from
// `MarkdownEditorContent.tsx` (5003df0bf). Opening the dialog therefore asks the
// unbundled dev server for roughly 390 more modules that the page load never
// requested. On a fresh server that one-time compile took ~5.5s against ~1.7s
// once cached, and it was charged to the first test's editor assertion. Loading
// the page and importing the editor module here, after Playwright has started
// the web server and before any test begins, keeps that compile out of the
// per-test budgets without loosening them.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type FullConfig } from "@playwright/test";

const WARMUP_TIMEOUT_MS = 180_000;
// Vite serves files outside the harness root under `/@fs/<absolute path>`.
const EDITOR_MODULE_URL = `/@fs${
	pathToFileURL(
		path.resolve(
			import.meta.dirname,
			"../../src/components/editor/MarkdownEditorContent.tsx"
		)
	).pathname
}`;

export default async function warmProjectSettingsEditor(
	config: FullConfig
): Promise<void> {
	const harnessUrl = config.webServer?.url;
	if (!harnessUrl) {
		throw new Error("The project settings config has no harness URL to warm.");
	}
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		page.setDefaultTimeout(WARMUP_TIMEOUT_MS);
		// `load` waits for the proof page's static module graph to evaluate.
		await page.goto(new URL("project-settings-proof.html", harnessUrl).href, {
			timeout: WARMUP_TIMEOUT_MS,
			waitUntil: "load",
		});
		// Importing the lazy editor module compiles its whole graph, as opening
		// the dialog does.
		await page.evaluate(async (moduleUrl) => {
			await import(moduleUrl);
		}, EDITOR_MODULE_URL);
	} finally {
		await browser.close();
	}
}
