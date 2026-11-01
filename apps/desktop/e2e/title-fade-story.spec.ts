// Real-browser spec for the clipped-title edge fade (`e2e/harness/
// title-fade-story.{html,tsx}`), which mounts the REAL `FadeLabel` and
// `OverflowTooltip fade` from `src/components/layout/overflow-tooltip.tsx`.
//
// The contract:
//   • a clipped line wears the fade mask — including one unbroken, space-free
//     token, the case the old single-element measurement always missed;
//   • the streaming shimmer state fades exactly like the resting state (it must
//     never fall back to an ellipsis);
//   • a label that fits wears no mask at all;
//   • nothing in the family relies on `text-overflow: ellipsis`.
//
// The control row (`legacy`) pins the root cause: an inline box reports
// clientWidth 0, so the pre-fix check compared 0 against 0.

import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/title-fade-story.html";

/** The clip box is the label's outer span — the element the mask is set on, and
 *  the first child of the row's title slot. */
function clip(page: import("@playwright/test").Page, testid: string) {
	return page.getByTestId(testid).locator("> span").first();
}

test.describe("clipped title edge fade — real components in isolation", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(STORY_URL);
		await expect(page.getByTestId("fade-unbroken")).toBeVisible();
	});

	test("an unbroken 200-character title fades at the clipped edge", async ({
		page,
	}) => {
		const mask = await clip(page, "fade-unbroken").evaluate(
			(el) => getComputedStyle(el).maskImage
		);
		expect(mask).toContain("linear-gradient");
	});

	test("a long title with spaces fades too", async ({ page }) => {
		const mask = await clip(page, "fade-spaced").evaluate(
			(el) => getComputedStyle(el).maskImage
		);
		expect(mask).toContain("linear-gradient");
	});

	test("the streaming shimmer state fades instead of ending in an ellipsis", async ({
		page,
	}) => {
		const shimmer = clip(page, "fade-shimmer");
		const style = await shimmer.evaluate((el) => ({
			mask: getComputedStyle(el).maskImage,
			ellipsis: getComputedStyle(el).textOverflow,
		}));
		expect(style.mask).toContain("linear-gradient");
		expect(style.ellipsis).toBe("clip");
		// The shimmer animation rides the inner span, not the clip box.
		await expect(
			page.getByTestId("fade-shimmer").locator(".an-text-shimmer--active")
		).toHaveCount(1);
	});

	test("a title that fits wears no mask", async ({ page }) => {
		const mask = await clip(page, "fade-short").evaluate(
			(el) => getComputedStyle(el).maskImage
		);
		expect(mask).toBe("none");
	});

	test("the legacy sidebar fade stays static", async ({ page }) => {
		const label = clip(page, "fade-unbroken");
		await label.hover();
		await expect
			.poll(() =>
				label.locator("> span").evaluate((el) => el.getAnimations().length)
			)
			.toBe(0);
	});

	test("the legacy accented label stays static", async ({ page }) => {
		const line = page.getByTestId("auto-scroll-text").locator("> span").first();
		await line.hover();
		await expect
			.poll(() =>
				line.locator("> span").evaluate((el) => el.getAnimations().length)
			)
			.toBe(0);
	});

	test("a rename crossfades the new title in place", async ({
		page,
	}, testInfo) => {
		// Since 0db714a247 (P1) a title change is a quiet 150ms opacity
		// crossfade of the whole title, not Torph's per-character morph.
		const title = page.getByTestId("animated-title");
		await expect(title.locator("[data-animated-title]")).toHaveAttribute(
			"data-animated-title-state",
			"settled"
		);

		await page.getByTestId("rename-title").click();
		const animated = title.locator("[data-animated-title]");
		await expect(animated).toHaveAttribute(
			"data-animated-title-state",
			"transitioning"
		);
		await expect(animated).toHaveText("New title");
		await expect(animated.locator("[torph-root]")).toHaveCount(0);
		await expect
			.poll(() =>
				animated.evaluate(
					(element) => element.getAnimations({ subtree: true }).length
				)
			)
			.toBeGreaterThan(0);
		await page.screenshot({
			path: testInfo.outputPath("title-rename-crossfade-proof.png"),
		});

		await expect(animated).toHaveAttribute(
			"data-animated-title-state",
			"settled",
			{ timeout: 2000 }
		);
		await expect(animated).toHaveText("New title");
	});

	test("the tab-title tooltip variant fades busy and resting alike", async ({
		page,
	}) => {
		for (const testid of ["tooltip-shimmer", "tooltip-resting"]) {
			const mask = await clip(page, testid).evaluate(
				(el) => getComputedStyle(el).maskImage
			);
			expect(mask, testid).toContain("linear-gradient");
		}
	});

	test("the pre-fix inline shape measures 0 — the root cause", async ({
		page,
	}) => {
		const box = await clip(page, "legacy").evaluate((el) => ({
			client: el.clientWidth,
			scroll: el.scrollWidth,
			display: getComputedStyle(el).display,
		}));
		expect(box.display).toBe("inline");
		expect(box.client).toBe(0);
		expect(box.scroll).toBe(0);
	});
});
