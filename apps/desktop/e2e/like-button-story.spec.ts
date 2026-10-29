// Real-browser spec for the like control (`e2e/harness/like-button-story.{html,tsx}`),
// which mounts the REAL `ItemLikeButton` behind the real `LikesStore` and the real
// `MarketplaceHostProvider` seam, with only the network faked.
//
// WHAT IT GUARDS, and why each assertion needs a browser rather than a DOM shim:
//
//   1. THE POP IS ON THE WRAPPER, NOT THE <svg>. The supplied CSS says so, and the
//      reason is a rendering fact: Chromium rasterises a transformed inline SVG at
//      1x, so the heart is visibly pixelated on hi-DPI for the length of every pop.
//      Only `getComputedStyle` can say which element the animation actually landed
//      on — a prop-shape assertion would pass on the broken version.
//   2. `.is-bursting` IS ADDED **AND REMOVED**. A class-present check passes on the
//      exact bug the CSS note warns about: if the class is never removed, the first
//      like animates and every like after it does nothing, because the class never
//      changed and so no animation restarts. This spec waits for it to go away and
//      then likes AGAIN, asserting the burst re-fires.
//   3. PER-PARTICLE VECTORS. Eight dots, each with its own --px/--py, set in JS.
//   4. THE REDUCED-MOTION BLOCK ACTUALLY BITES. Asserted under a real
//      `prefers-reduced-motion: reduce` emulation, on resolved animation names.
//   5. OPTIMISTIC FILL + ROLLBACK, observed through the DOM: the heart is filled
//      before the request resolves, and a failing write leaves no phantom count.

import { expect, type Page, test } from "@playwright/test";

const OK = '[data-testid="row-ok"] [data-testid="item-like-button"]';
const SEEDED = '[data-testid="row-seeded"] [data-testid="item-like-button"]';
const FAILS = '[data-testid="row-fails"] [data-testid="item-like-button"]';
const ANON = '[data-testid="row-anon"] [data-testid="item-like-button"]';
const CARD = '[data-testid="row-card"]';

/** The animation actually applied to one element, as the browser resolved it. */
function animationOf(page: Page, selector: string): Promise<string> {
	return page
		.locator(selector)
		.evaluate((el) => getComputedStyle(el).animationName);
}

test.beforeEach(async ({ page }) => {
	await page.goto("/like-button-story.html");
	await expect(page.locator(OK)).toBeVisible();
});

test("a seeded card paints its true state with no flash", async ({ page }) => {
	// Seeded with `liked: true` — it must be filled on the FIRST paint. If the
	// component waited for a request, this would be "false" here and flip later,
	// which is the flash the seed exists to prevent.
	await expect(page.locator(SEEDED)).toHaveAttribute("data-liked", "true");
	await expect(page.locator(SEEDED)).toContainText("99");
});

test("the heart fills and the count moves BEFORE the request resolves", async ({
	page,
}) => {
	const button = page.locator(OK);
	await expect(button).toContainText("12");
	await expect(button).toHaveAttribute("data-liked", "false");

	await button.click();

	// The fake transport takes 250ms; this must already be true.
	await expect(button).toHaveAttribute("data-liked", "true", { timeout: 100 });
	await expect(button).toContainText("13");
});

test("the pop animation is on the WRAPPER, never on the <svg>", async ({
	page,
}) => {
	await page.locator(OK).click();
	await expect(page.locator(OK)).toHaveAttribute("data-liked", "true");

	// The wrapper carries it…
	expect(await animationOf(page, `${OK} .t-like-icon`)).toBe("t-like-pop");
	// …and the SVG itself must carry nothing. A transform here is what makes the
	// vector rasterise at 1x and go pixelated on a hi-DPI display.
	expect(await animationOf(page, `${OK} .t-like-heart`)).toBe("none");
	const svgTransform = await page
		.locator(`${OK} .t-like-heart`)
		.evaluate((el) => getComputedStyle(el).transform);
	expect(
		svgTransform === "none" || svgTransform === "matrix(1, 0, 0, 1, 0, 0)"
	).toBe(true);
});

test("the burst fires with eight per-particle vectors", async ({ page }) => {
	await page.locator(OK).click();
	await expect(page.locator(OK)).toHaveClass(/is-bursting/);

	const dots = page.locator(`${OK} .t-like-particles i`);
	await expect(dots).toHaveCount(8);

	const vectors = await dots.evaluateAll((els) =>
		els.map((el) => ({
			animation: getComputedStyle(el).animationName,
			px: el.style.getPropertyValue("--px"),
			py: el.style.getPropertyValue("--py"),
			dur: el.style.getPropertyValue("--pdur"),
		}))
	);
	for (const vector of vectors) {
		expect(vector.animation).toBe("t-like-burst");
		expect(vector.px).toMatch(/px$/);
		expect(vector.py).toMatch(/px$/);
		expect(vector.dur).toMatch(/ms$/);
	}
	// An organic spray, not eight dots on one line.
	expect(new Set(vectors.map((v) => `${v.px}|${v.py}`)).size).toBe(8);
});

test("`.is-bursting` is REMOVED, so a second like re-fires the burst", async ({
	page,
}) => {
	const button = page.locator(OK);

	await button.click();
	await expect(button).toHaveClass(/is-bursting/);
	// THE assertion the CSS note is about. Leaving the class on is the bug, and a
	// present-only check would pass on it.
	await expect(button).not.toHaveClass(/is-bursting/, { timeout: 3000 });

	// Unlike (no burst — a burst on an unlike would read as a second like)…
	await button.click();
	await expect(button).toHaveAttribute("data-liked", "false");
	await expect(button).not.toHaveClass(/is-bursting/);

	// …then like again. The class must come back; if it had never been removed,
	// nothing here would animate.
	await button.click();
	await expect(button).toHaveClass(/is-bursting/);
});

test("a failed write rolls back and leaves no phantom count", async ({
	page,
}) => {
	const button = page.locator(FAILS);
	await expect(button).toContainText("7");

	await button.click();
	// Optimistic first…
	await expect(button).toHaveAttribute("data-liked", "true", { timeout: 100 });
	await expect(button).toContainText("8");

	// …then the rejection lands and the control returns to server truth. Not 7
	// and liked, not 8 and unliked — both of those are the phantom.
	await expect(button).toHaveAttribute("data-liked", "false", {
		timeout: 3000,
	});
	await expect(button).toContainText("7");
});

test("the control carries no button chrome (it is a GHOST)", async ({
	page,
}) => {
	const box = await page.locator(OK).evaluate((el) => {
		const style = getComputedStyle(el);
		return {
			background: style.backgroundColor,
			borderWidth: style.borderTopWidth,
			padding: style.paddingTop + style.paddingLeft,
		};
	});
	// No pill, no border, no background wash — bare glyph + number.
	expect(box.background).toBe("rgba(0, 0, 0, 0)");
	expect(box.borderWidth).toBe("0px");
	expect(box.padding).toBe("0px0px");
	// And no "Like" text label: the content is the heart and the number only.
	await expect(page.locator(OK)).not.toContainText(/like/i);
});

test("a SIGNED-OUT visitor sees the count, and a click prompts instead of liking", async ({
	page,
}) => {
	const button = page.locator(ANON);

	// NOT hidden and NOT disabled. Hiding it would withhold real information from
	// the page most likely to be read signed-out; disabling it explains nothing.
	await expect(button).toBeVisible();
	await expect(button).toBeEnabled();
	await expect(button).toContainText("5");

	await button.click();

	// The prompt fired…
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: like-button-story.tsx installs __likeAuthPrompts before this proof page is evaluated. */ (
						window as Window & { __likeAuthPrompts: string[] }
					).__likeAuthPrompts.length
			)
		)
		.toBe(1);
	// …and NOTHING moved. Not the heart, not the count — and critically, no
	// burst: eight particles celebrating a like that did not happen is the bug
	// this asserts against.
	await expect(button).toHaveAttribute("data-liked", "false");
	await expect(button).toContainText("5");
	await expect(button).not.toHaveClass(/is-bursting/);
});

test("the heart sits in the card row without breaking it", async ({ page }) => {
	// The REAL `StoreCatalogCard`, the row every catalog list renders. The card's
	// own header records that six badges per row is what made a grid look busy;
	// this control is a new occupant of that same right-hand cluster.
	const hearts = page.locator(`${CARD} [data-testid="item-like-button"]`);
	await expect(hearts).toHaveCount(2);

	// The seeded row is already filled with its true count on first paint.
	await expect(hearts.nth(1)).toHaveAttribute("data-liked", "true");
	await expect(hearts.nth(1)).toContainText("4");

	// One row, not two: the heart, the action and the text all share the card's
	// vertical band. Compare against the row's own box rather than a fixed pixel
	// figure so this survives a type-scale change.
	const rows = page.locator(`${CARD} > div`);
	for (let i = 0; i < 2; i += 1) {
		const row = await rows.nth(i).boundingBox();
		const heart = await hearts.nth(i).boundingBox();
		if (!(row && heart)) {
			throw new Error("card row or heart not laid out");
		}
		expect(heart.y).toBeGreaterThanOrEqual(row.y);
		expect(heart.y + heart.height).toBeLessThanOrEqual(row.y + row.height);
		// The heart must not be pushed outside the card's width by the action.
		expect(heart.x + heart.width).toBeLessThanOrEqual(row.x + row.width + 1);
	}

	await page.locator(CARD).screenshot({
		path: "test-results/like-button-card-row.png",
	});
});

test.describe("reduced motion", () => {
	test("suppresses both the pop and the particles", async ({ page }) => {
		// `emulateMedia` rather than the `reducedMotion` fixture: the fixture did
		// NOT reach the page in this harness (`matchMedia("(prefers-reduced-motion:
		// reduce)").matches` stayed false), so a spec relying on it would have
		// asserted the reduced-motion block while the browser was still in its
		// default state — a green that proves nothing. This call is verified by the
		// assertion immediately below it.
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.goto("/like-button-story.html");
		const matches = await page.evaluate(
			() => matchMedia("(prefers-reduced-motion: reduce)").matches
		);
		expect(matches).toBe(true);

		const button = page.locator(OK);
		await button.click();
		await expect(button).toHaveAttribute("data-liked", "true");

		// The @media block in the supplied CSS must survive any restyling.
		expect(await animationOf(page, `${OK} .t-like-icon`)).toBe("none");
		const dotAnimations = await page
			.locator(`${OK} .t-like-particles i`)
			.evaluateAll((els) =>
				els.map((el) => getComputedStyle(el).animationName)
			);
		expect(dotAnimations).toHaveLength(8);
		for (const name of dotAnimations) {
			expect(name).toBe("none");
		}
		// The state still changes — reduced motion removes the animation, not the
		// feature.
		await expect(button).toContainText("13");
	});
});
