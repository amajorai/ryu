// Real-browser spec for the card's MILLED EDGE, mounted through the employee
// badge story (`e2e/harness/employee-badge-story.{html,tsx}`) — the desktop's
// own instance of the shared `PassCardShell`.
//
// WHAT IT GUARDS. The card's thickness is a stack of slices along Z, and each
// slice is tinted for its OWN depth: shoulders in shadow, a bright core. That
// per-slice tint is the only thing shading the edge ACROSS its thickness — the
// brushed ramp underneath runs along the card's LENGTH and is identical on every
// slice. Lose the tint and the thickness becomes one flat repeated column, the
// two face rings become the only depth cue, and the card reads as TWO cards
// stacked and joined at the waist. That exact report has now been filed twice:
// once against a symmetric ramp, and once after a merge kept the ramp and the
// slice geometry from the fix but dropped the tint.
//
// `packages/ui/src/components/pass-edge.test.ts` guards the arithmetic. This
// guards that the arithmetic reaches the DOM — a `bun test` cannot see a slice
// whose fill was overwritten at the call site, which is precisely how the
// regression landed the second time.

import { expect, test } from "@playwright/test";

/** The near-black of the per-depth shadow layer, as Chromium serialises it. */
const SHADOW_LAYER = "rgba(10, 10, 14";
/** The white of the per-depth sheen layer. */
const SHEEN_LAYER = "rgba(255, 255, 255";

test.beforeEach(async ({ page }) => {
	await page.goto("/employee-badge-story.html");
	await expect(page.getByText("Grace Hopper").first()).toBeVisible();
});

/** Every element carrying a depth-tinted slice fill, as computed by the browser. */
async function sliceFills(page: import("@playwright/test").Page) {
	return await page.evaluate(
		({ shadow }) =>
			[...document.querySelectorAll<HTMLElement>("div")]
				.map((element) => getComputedStyle(element).backgroundImage)
				.filter((image) => image.includes(shadow)),
		{ shadow: SHADOW_LAYER }
	);
}

test("the milled edge is shaded across its thickness, not one flat column", async ({
	page,
}) => {
	const fills = await sliceFills(page);
	// Two columns (light + dark), several slices each.
	expect(fills.length).toBeGreaterThan(4);
	// THE assertion. Identical fills on every slice is the regression.
	expect(new Set(fills).size).toBeGreaterThan(1);
});

test("every slice carries both the shadow and the sheen layer", async ({
	page,
}) => {
	const fills = await sliceFills(page);
	// Guards against passing vacuously: a stack with the tint stripped has NO
	// element matching the shadow layer at all, and a `for` over nothing asserts
	// nothing.
	expect(fills.length).toBeGreaterThan(4);
	for (const fill of fills) {
		expect(fill).toContain(SHEEN_LAYER);
		// The brushed ramp must sit UNDER the tint: background layers paint
		// first-on-top, so a metal gradient listed first would hide both.
		expect(fill.lastIndexOf("linear-gradient")).toBeGreaterThan(
			fill.indexOf(SHADOW_LAYER)
		);
	}
});

test("the shoulders are darker than the core", async ({ page }) => {
	const fills = await sliceFills(page);
	const shadowAlphas = fills.map((fill) => {
		const match = /rgba\(10, 10, 14, ([\d.]+)\)/.exec(fill);
		return match ? Number.parseFloat(match[1]) : Number.NaN;
	});
	const spread = Math.max(...shadowAlphas) - Math.min(...shadowAlphas);
	// A stack with no depth ramp has a spread of exactly zero.
	expect(spread).toBeGreaterThan(0.1);
});
