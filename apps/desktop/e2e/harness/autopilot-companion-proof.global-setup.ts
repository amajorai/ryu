// Warms the harness Vite dev server once before the autopilot proof runs.
//
// The proof page imports the real ExtensionHost, toast host, and UI kit through
// Vite's unbundled dev server. The first navigation transforms that whole module
// graph (and can re-run dependency optimization and reload the page). On a busy
// runner that one-time compile outlasts a test's 30s budget, and it was charged
// to whichever test navigated first. Loading the page here, after Playwright has
// started the web server and before any test begins, keeps that cost out of the
// per-test budgets without loosening them.

import { chromium, type FullConfig } from "@playwright/test";

const PROOF_PAGE = "autopilot-companion-proof.html";
const WARMUP_TIMEOUT_MS = 180_000;

export default async function warmAutopilotProofPage(
	config: FullConfig
): Promise<void> {
	const baseURL = config.projects[0]?.use.baseURL;
	if (!baseURL) {
		throw new Error("The autopilot proof config has no baseURL to warm.");
	}
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.goto(new URL(PROOF_PAGE, baseURL).href, {
			timeout: WARMUP_TIMEOUT_MS,
			waitUntil: "domcontentloaded",
		});
		await page
			.locator('body[data-harness-ready="1"]')
			.waitFor({ state: "attached", timeout: WARMUP_TIMEOUT_MS });
	} finally {
		await browser.close();
	}
}
