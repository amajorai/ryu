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
//   4. THE HERO TILE'S MATERIAL COVERS ITS GLYPH. Not geometry, but the same "only
//      a real browser can answer it" class: an art-less hero tile is the SVG icon
//      material behind a theme-gated layer, and the glyph sits on it, so the
//      material the active theme shows must be opaque under the glyph. The only
//      honest check is rasterising the computed background and reading its alpha.
//      (The tile used to be a dither canvas run through `opaqueDither`; the icon
//      material replaced it before 07d403e33, which left the old canvas probe
//      with nothing to find.)

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

test("the hero tile's material stays opaque under its glyph", async ({
	page,
}) => {
	await page.setViewportSize(WIDE);
	// The hero tile is `AppIcon`'s `hero` variant. It no longer paints a dither
	// CANVAS (the banner gets an item-declared gradient here, so no canvas exists
	// in the hero at all): an art-less tile is the SVG icon material, a light
	// rounded plate in light theme and a dark one in dark theme, applied as the
	// `--catalog-icon-material` background of a theme-gated layer. The tile is
	// told apart from the banner by its box, as before.
	const tile = page.locator(
		"[data-testid='dialog'] [data-app-icon='fallback']"
	);
	await expect(tile).toHaveCount(1);
	await expect(tile).toBeVisible();
	const box = await tile.boundingBox();
	expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(112);

	// The MINIMUM alpha over the glyph's area of the material the theme actually
	// shows, rasterised from the computed background — not a sampled pixel, so a
	// dissolving wash cannot pass on its solid end. The rounded corners are outside
	// the measured inner 60% square on purpose: they are transparent by design.
	const minAlpha = await tile.evaluate(async (el) => {
		const layer = Array.from(el.children).find(
			(child) =>
				child instanceof HTMLElement &&
				getComputedStyle(child).display !== "none" &&
				getComputedStyle(child).backgroundImage.startsWith("url(")
		);
		if (!(layer instanceof HTMLElement)) {
			throw new Error("no visible material layer on the hero tile");
		}
		const source = /^url\("(.*)"\)$/s.exec(
			getComputedStyle(layer).backgroundImage
		)?.[1];
		if (!source) {
			throw new Error("the material layer has no url() background");
		}
		const image = new Image();
		image.src = source;
		await image.decode();
		const size = 256;
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("no 2d context for the material probe");
		}
		ctx.drawImage(image, 0, 0, size, size);
		const inset = Math.round(size * 0.2);
		const { data } = ctx.getImageData(
			inset,
			inset,
			size - inset * 2,
			size - inset * 2
		);
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
