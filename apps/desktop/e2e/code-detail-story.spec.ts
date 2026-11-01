// Real-browser spec for the code-detail story (`e2e/harness/
// code-detail-story.{html,tsx}`), which renders the REAL `Markdown` with a
// 300-line fenced block under both values of the `expandCodeBlocks` chat-display
// pref.
//
// The contract under test: Settings → Appearance → Detail level reaches code
// blocks, not just tool calls. Below the Detailed level a long block is CAPPED
// AND SCROLLABLE — capped so one paste cannot bury the rest of a reply, scrollable
// because code the model wrote must never become unreachable. At Detailed it is
// uncapped.
//
// This is a selector-matching test as much as a behaviour one: the cap is a CSS
// rule aimed at `@streamdown/code`'s own `data-streamdown` parts, so a plugin
// upgrade that renames or re-nests them fails here rather than silently reverting
// every user to full-height code.

import { expect, test } from "@playwright/test";

// Cold Vite compiles the streamdown + shiki module graph on first navigation.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/code-detail-story.html";
const BODY = '[data-streamdown="code-block-body"]';

test("below Detailed, a long code block is capped and scrolls", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const body = page.getByTestId("capped").locator(BODY);
	await expect(body).toBeVisible();
	// The reply renderer loads lazily since 523665000e: its fallback is the
	// plain text in the same box and the highlighted block replaces it, so the
	// geometry is read (and re-read) until the rendered block settles.
	await expect(async () => {
		const metrics = await body.evaluate((el) => ({
			clientHeight: el.clientHeight,
			scrollHeight: el.scrollHeight,
			maxHeight: getComputedStyle(el).maxHeight,
			overflowY: getComputedStyle(el).overflowY,
		}));
		// The cap landed on this element at all…
		expect(metrics.maxHeight).not.toBe("none");
		// …it is doing something (content exceeds the box)…
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
		// …and the overflow is reachable rather than clipped away.
		expect(["auto", "scroll"]).toContain(metrics.overflowY);

		const scrolled = await body.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
			return el.scrollTop;
		});
		expect(scrolled).toBeGreaterThan(0);
	}).toPass();
});

test("at Detailed, the same block renders uncapped", async ({ page }) => {
	await page.goto(STORY_URL);
	const body = page.getByTestId("full").locator(BODY);
	await expect(body).toBeVisible();

	const metrics = await body.evaluate((el) => ({
		clientHeight: el.clientHeight,
		scrollHeight: el.scrollHeight,
		maxHeight: getComputedStyle(el).maxHeight,
	}));
	expect(metrics.maxHeight).toBe("none");
	// Nothing hidden: the box is as tall as its content.
	expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
});

test("the capped block is materially shorter than the uncapped one", async ({
	page,
}) => {
	// The cross-check that neither variant is quietly getting the other's
	// treatment — a single-variant assertion would pass if the pref were ignored
	// and BOTH rendered the same way.
	await page.goto(STORY_URL);
	const capped = page.getByTestId("capped").locator(BODY);
	const full = page.getByTestId("full").locator(BODY);
	const cappedHeight = await capped.evaluate((el) => el.clientHeight);
	const fullHeight = await full.evaluate((el) => el.clientHeight);
	expect(cappedHeight).toBeLessThan(fullHeight);
});
