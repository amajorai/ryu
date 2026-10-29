// Warms a Marketplace Store harness's Vite dev server once before its specs run.
//
// Each Store story mounts the real `StorePage` through Vite's unbundled dev
// server: about 1,500 module requests, plus a prebundle of roughly 140
// dependencies on a fresh cache. Measured on an idle 4-core runner, that first
// navigation takes ~24s (~15s once the dependency cache exists) against ~4s for
// every later one, and it was charged to whichever test navigated first. Loading
// the story here, after Playwright has started the web server and before any
// test begins, keeps that one-time compile out of the per-test budgets without
// loosening them.

import { chromium, type FullConfig } from "@playwright/test";

const WARMUP_TIMEOUT_MS = 180_000;

export default async function warmMarketplaceStoreStory(
	config: FullConfig
): Promise<void> {
	// The readiness URL every Store config declares is the story its specs load.
	const storyUrl = config.webServer?.url;
	if (!storyUrl) {
		throw new Error("The Marketplace Store config has no story URL to warm.");
	}
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		// `load` waits for the story's whole static module graph to evaluate.
		await page.goto(storyUrl, {
			timeout: WARMUP_TIMEOUT_MS,
			waitUntil: "load",
		});
	} finally {
		await browser.close();
	}
}
