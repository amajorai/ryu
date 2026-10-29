// Real-browser spec for the store-listing detail shell
// (`e2e/harness/listing-detail-story.{html,tsx}`), which mounts the REAL
// `ListingDetailShell` + hero/stat-strip/gallery/rail primitives that every Store
// tab's preview dialog now renders inside.
//
// WHAT IT GUARDS, and why it needs a browser. The regression this layout replaced
// was purely geometric: the preview bodies were authored for a 26rem side pane
// that no caller can open any more, so at the dialog's real width they rendered as
// one thin column. The invariants below are all facts about resolved geometry —
// element widths, sibling ordering, scroll extents — which a type-check and a
// happy-dom render both answer "yes" to regardless of whether the CSS works.
//
//   1. TWO COLUMNS at dialog width. The Information rail must sit BESIDE the main
//      column, not under it. Asserted as "the rail's top is within the main
//      column's vertical span", which is true only when `lg:flex-row` applies.
//   2. NO HORIZONTAL PAGE SCROLL. The whole point of a wider dialog is defeated if
//      it overflows sideways. The stat strip (8 cells) and gallery (5 shots) are
//      both wider than the column and must scroll INSIDE their own band.
//   3. ONE COLUMN when narrow. Below the breakpoint the rail stacks under the main
//      column — the small-window presentation, which must not be a squeezed
//      two-up.
//   4. THE HERO TILE'S WASH COVERS ITS BOX. Not geometry, but the same "only a real
//      browser can answer it" class: the tile's glyph is hardcoded `text-white`
//      because it sits on the hero above the scrim, so the wash under it must be
//      opaque. Every packaged manifest now declares a spec that DISSOLVES to
//      transparent, and painted as-is the tile's far end would be the banner
//      behind it — near-white in light theme, taking the glyph with it. The hero
//      runs the spec through `opaqueDither` for exactly this, and the only honest
//      check of that is reading the canvas's own alpha.

import { expect, test } from "@playwright/test";

const WIDE = { width: 1600, height: 1000 };
const NARROW = { width: 720, height: 1000 };

test.beforeEach(async ({ page }) => {
	await page.goto("/listing-detail-story.html");
	await page.waitForSelector("body[data-harness-ready='1']");
});

test("renders two columns at dialog width", async ({ page }) => {
	await page.setViewportSize(WIDE);
	const main = page.locator("main, [data-testid='dialog'] section").first();
	const rail = page.locator("aside").first();
	await expect(rail).toBeVisible();

	const mainBox = await main.boundingBox();
	const railBox = await rail.boundingBox();
	if (!(mainBox && railBox)) {
		throw new Error("missing layout boxes");
	}
	// Side by side: the rail starts to the RIGHT of the main column's right edge
	// (minus a tolerance for the gap), and vertically overlaps it.
	expect(railBox.x).toBeGreaterThan(mainBox.x + mainBox.width - 8);
	expect(railBox.y).toBeLessThan(mainBox.y + mainBox.height);
});

test("never scrolls the page sideways", async ({ page }) => {
	await page.setViewportSize(WIDE);
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test("renders GitHub presentation metadata and screenshots", async ({
	page,
}, testInfo) => {
	await page.setViewportSize(WIDE);
	await expect(page.getByText("Repository")).toBeVisible();
	await expect(page.getByText("Privacy Policy")).toBeVisible();
	await expect(page.getByText("Terms of Service")).toBeVisible();
	await expect(page.getByText("Browser toolkit").first()).toBeVisible();
	await expect(page.getByText("Example prompts")).toBeVisible();

	const screenshots = page.locator("img[alt^='Example App screenshot']");
	await expect(screenshots).toHaveCount(5);
	expect(
		await screenshots.first().evaluate((image) => {
			if (!(image instanceof HTMLImageElement)) {
				throw new Error("Expected proof element to be an HTMLImageElement.");
			}
			return image.naturalWidth;
		})
	).toBeGreaterThan(0);

	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("marketplace-rich-metadata-hero.png"),
	});
	await page.locator("html").evaluate((element) => {
		element.classList.add("dark");
	});
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("marketplace-rich-metadata-hero-dark.png"),
	});
	await page.locator("[data-testid='dialog']").evaluate((element) => {
		element.scrollTop = 250;
	});
	await page.screenshot({
		path: testInfo.outputPath("marketplace-rich-metadata-rail.png"),
	});
	await page.locator("[data-testid='dialog']").evaluate((element) => {
		element.scrollTop = 650;
	});
	await page.screenshot({
		path: testInfo.outputPath("marketplace-rich-metadata-capabilities.png"),
	});
});

test("renders the support, extension, and implementation split", async ({
	page,
}, testInfo) => {
	await page.setViewportSize(WIDE);
	await expect(page.getByText("Support & extensions")).toBeVisible();
	await expect(page.getByTestId("surface-support")).toContainText("Desktop");
	await expect(page.getByTestId("surface-support")).toContainText("Mobile");
	await expect(page.getByTestId("surface-support")).toContainText(
		"Uses the shared Desktop shell"
	);
	await expect(page.getByTestId("surface-extensions")).toContainText(
		"Browser control"
	);
	await expect(page.getByTestId("surface-implementation")).toContainText(
		"Core runtime"
	);
	await expect(page.getByTestId("surface-implementation")).toContainText(
		"Package sidecar"
	);
	await page.getByTestId("surface-support").scrollIntoViewIfNeeded();
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("marketplace-support-extension-proof.png"),
	});
});

test("stat strip scrolls inside its own band", async ({ page }) => {
	await page.setViewportSize(NARROW);
	// The strip is the only `overflow-x-auto` band directly under the action bar.
	const strip = page.locator("[data-testid='dialog'] .overflow-x-auto").first();
	const scrollable = await strip.evaluate(
		(el) => el.scrollWidth > el.clientWidth
	);
	expect(scrollable).toBe(true);
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test("the hero tile's wash stays opaque under its white glyph", async ({
	page,
}) => {
	await page.setViewportSize(WIDE);
	// Two canvases live in the hero: the full-bleed banner and the icon tile. They
	// are told apart by size rather than by DOM order, because order is an
	// implementation detail of the hero's markup and a box under ~7rem can only be
	// the tile (the banner spans the dialog).
	const canvases = page.locator("[data-testid='dialog'] canvas");
	await expect(canvases.first()).toBeVisible();
	const total = await canvases.count();
	const tiles: number[] = [];
	for (let i = 0; i < total; i++) {
		const box = await canvases.nth(i).boundingBox();
		if (box && box.width <= 112) {
			tiles.push(i);
		}
	}
	expect(tiles).toHaveLength(1);

	// The MINIMUM alpha across the whole backing canvas, not a sampled pixel: a
	// dissolve is a gradient, so any single sample can land on the solid end and
	// pass while the other end is see-through. A two-tone ramp paints every cell,
	// so its minimum is the opacity multiplier — full here.
	const minAlpha = await canvases.nth(tiles[0]).evaluate((el) => {
		if (!(el instanceof HTMLCanvasElement)) {
			throw new Error("Expected proof element to be an HTMLCanvasElement.");
		}
		const canvas = el;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("no 2d context on the tile canvas");
		}
		const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
		let min = 255;
		for (let i = 3; i < data.length; i += 4) {
			if (data[i] < min) {
				min = data[i];
			}
		}
		return min;
	});
	expect(minAlpha).toBeGreaterThan(200);
});

test("stacks to one column when narrow", async ({ page }) => {
	await page.setViewportSize(NARROW);
	const main = page.locator("[data-testid='dialog'] section").first();
	const rail = page.locator("aside").first();
	const mainBox = await main.boundingBox();
	const railBox = await rail.boundingBox();
	if (!(mainBox && railBox)) {
		throw new Error("missing layout boxes");
	}
	expect(railBox.y).toBeGreaterThan(mainBox.y);
	expect(Math.abs(railBox.x - mainBox.x)).toBeLessThan(8);
});
