// Real-browser spec for `e2e/harness/agent-banner-story.{html,tsx}` — the agent
// banner customisation dialog, and the `bare` settings row that removes the box
// around a tall text control.
//
// Both contracts are about PAINT, which is why they are here and not in a unit
// test:
//
//   * A banner style is a CSS background or a `<canvas>`. "Picking Prism changed
//     the banner" is a computed style; a jsdom assertion that the handler fired
//     would pass just as happily if the wash never moved.
//   * A doubled border is the presence of a second painted surface around a
//     control. The only way to know it is gone is to walk the control's rendered
//     ancestors and ask each one what it paints — which needs a layout engine.
//
// The style-preset assertions deliberately do NOT hardcode the full preset list.
// The list comes from the shared `ANIMATED_GRADIENT_PRESETS` table that the
// marketplace's listing banners also read, so a preset added there must widen
// this picker WITHOUT failing this spec. What is asserted is the invariant: the
// dither style is present and first, at least one gradient style exists, every
// tile is labelled, and picking a gradient paints the shared static gradient.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";

const STORY_URL = "/agent-banner-story.html";
const MARKETPLACE_PROOF_DIR = path.resolve(
	import.meta.dirname,
	"../../docs/proof/marketplace-wallpaper-banners"
);

/** The shared static painter (`animatedGradientCss`) always emits two radial
 *  pools plus a linear ramp. Its signature, and what tells a real gradient
 *  preset apart from a hand-rolled two-stop ramp. */
const GRADIENT_SIGNATURE = /radial-gradient.*radial-gradient.*linear-gradient/s;

/** Every painted background on `el` and its ancestors up to (not including)
 *  `stopAt`. Used to prove a bare control has NO card behind it while the same
 *  control inside a card has one. */
async function ancestorBackgrounds(el: Locator, stopAt: string) {
	return await el.evaluate((node, selector) => {
		const out: string[] = [];
		let current: HTMLElement | null = node.parentElement;
		while (current && !current.matches(selector)) {
			const style = getComputedStyle(current);
			const color = style.backgroundColor;
			const transparent =
				color === "rgba(0, 0, 0, 0)" ||
				color === "transparent" ||
				/,\s*0\)$/.test(color);
			if (!transparent || style.backgroundImage !== "none") {
				out.push(`${color} | ${style.backgroundImage}`);
			}
			current = current.parentElement;
		}
		return out;
	}, stopAt);
}

test.describe("agent banner dialog", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(STORY_URL);
		await expect(page.getByTestId("banner-header")).toBeVisible();
	});

	test("profile banner feathers into its card body", async ({
		page,
	}, testInfo) => {
		await expect(page.getByTestId("banner-body")).toBeVisible();
		await page.screenshot({
			fullPage: true,
			path: testInfo.outputPath("agent-profile-banner-feather.png"),
		});
	});

	test("profile banner feathers into its light card body", async ({
		page,
	}, testInfo) => {
		await page.goto(`${STORY_URL}?theme=light`);
		await expect(page.getByTestId("banner-header")).toBeVisible();
		await expect(page.getByTestId("banner-body")).toBeVisible();
		await page.screenshot({
			fullPage: true,
			path: testInfo.outputPath("agent-profile-banner-feather-light.png"),
		});
	});

	test("defaults to the dither wash, painted on a canvas", async ({ page }) => {
		await expect(page.getByTestId("banner-state")).toContainText("dither/");
		await expect(
			page.getByTestId("banner-header").locator("canvas")
		).toHaveCount(1);
	});

	test("offers the dither style first and at least one gradient", async ({
		page,
	}) => {
		await page.getByRole("button", { name: "Customize" }).click();
		const tiles = page.getByTestId("banner-style-tile");
		const count = await tiles.count();
		expect(count).toBeGreaterThan(1);
		await expect(tiles.first()).toContainText("Dither");
		for (let i = 0; i < count; i++) {
			// A tile with no label is a preset the user cannot tell apart from its
			// neighbour — the failure mode of deriving the list from a table.
			await expect(tiles.nth(i)).not.toHaveText("");
		}
	});

	test("picking a gradient paints the shared gradient on preview and banner", async ({
		page,
	}) => {
		await page.getByRole("button", { name: "Customize" }).click();
		const gradientTile = page.getByTestId("banner-style-tile").nth(1);
		const label = (await gradientTile.innerText()).trim();
		await gradientTile.click();

		// The state line proves the pick was stored under the SHARED preset id, not
		// a local alias.
		await expect(page.getByTestId("banner-state")).toContainText(
			`${label.toLowerCase()}/`
		);

		const preview = page.getByTestId("banner-preview").locator("div").first();
		await expect(preview).toHaveCSS("background-image", GRADIENT_SIGNATURE);

		// The banner BEHIND the dialog moved too: the dialog is instant-apply, so a
		// preview that updates alone would be a lie.
		const header = page.getByTestId("banner-header").locator("div").first();
		await expect(header).toHaveCSS("background-image", GRADIENT_SIGNATURE);
		await expect(
			page.getByTestId("banner-header").locator("canvas")
		).toHaveCount(0);
	});

	test("the colour control recolours a gradient preset", async ({ page }) => {
		await page.getByRole("button", { name: "Customize" }).click();
		await page.getByTestId("banner-style-tile").nth(1).click();
		const preview = page.getByTestId("banner-preview").locator("div").first();
		const before = await preview.evaluate(
			(n) => getComputedStyle(n).backgroundImage
		);
		await page.getByRole("button", { name: "Banner colour green" }).click();
		await expect(page.getByTestId("banner-state")).toContainText("/green/");
		const after = await preview.evaluate(
			(n) => getComputedStyle(n).backgroundImage
		);
		expect(after).not.toBe(before);
		expect(after).toMatch(GRADIENT_SIGNATURE);
	});

	test("direction is offered for dither only", async ({ page }) => {
		await page.getByRole("button", { name: "Customize" }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("Direction");
		await page.getByTestId("banner-style-tile").nth(1).click();
		// A gradient preset carries its own angle, so a direction control there
		// would be a knob that does nothing.
		await expect(dialog).not.toContainText("Direction");
	});

	test("reset returns to the derived dither default", async ({ page }) => {
		await page.getByRole("button", { name: "Customize" }).click();
		await page.getByTestId("banner-style-tile").nth(1).click();
		await expect(page.getByTestId("banner-state")).not.toContainText("dither/");
		await page.getByRole("button", { name: "Reset to default" }).click();
		await expect(page.getByTestId("banner-state")).toContainText("dither/");
		await expect(
			page.getByTestId("banner-header").locator("canvas")
		).toHaveCount(1);
	});

	test("chooses a Marketplace shader wallpaper and persists its portable node selection", async ({
		page,
	}) => {
		await mkdir(MARKETPLACE_PROOF_DIR, { recursive: true });
		await page.getByRole("button", { name: "Customize" }).click();
		await page
			.getByRole("button", { name: "Browse Marketplace wallpapers" })
			.click();

		const picker = page.getByRole("dialog").filter({
			has: page.getByRole("heading", {
				name: "Choose an agent banner wallpaper",
			}),
		});
		await expect(picker).toBeVisible();
		await expect(picker.getByText("260 of 260 wallpapers")).toBeVisible();
		await page.screenshot({
			fullPage: true,
			path: path.join(MARKETPLACE_PROOF_DIR, "agent-wallpaper-picker.png"),
		});

		const meshGradientId = "com.ryu.marketplace-defaults:mesh-gradient";
		await page.getByTestId(`banner-wallpaper-${meshGradientId}`).click();
		await expect(page.getByTestId("banner-state")).toContainText(
			`wallpaper=${meshGradientId}`
		);
		await expect(
			page
				.getByTestId("banner-header")
				.locator(`[data-backdrop-id="${meshGradientId}"]`)
		).toBeVisible();

		const stored = await page.evaluate(() =>
			localStorage.getItem("proof:node:agent-banner:banner-story-agent")
		);
		expect(stored).not.toBeNull();
		const parsedStorage: unknown = JSON.parse(stored ?? "{}");
		expect(parsedStorage).toMatchObject({
			wallpaper: {
				backdropId: "shader-mesh-gradient",
				id: meshGradientId,
			},
		});
		await page.getByRole("button", { name: "Done" }).click();
		await page.getByTestId("banner-header").screenshot({
			path: path.join(MARKETPLACE_PROOF_DIR, "agent-marketplace-banner.png"),
		});
	});
});

test.describe("bare settings rows", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(STORY_URL);
		await expect(page.getByTestId("settings-pane")).toBeVisible();
	});

	test("a bare row's textarea has no card painted behind it", async ({
		page,
	}) => {
		const bare = await ancestorBackgrounds(
			page.getByTestId("bare-textarea"),
			'[data-testid="settings-pane"]'
		);
		expect(bare).toEqual([]);
	});

	test("an ordinary carded textarea still has one — the contrast case", async ({
		page,
	}) => {
		// If this ever comes back empty, the first assertion is vacuous: it would
		// be passing because nothing paints a card anywhere, not because `bare`
		// removed one.
		const carded = await ancestorBackgrounds(
			page.getByTestId("carded-textarea"),
			'[data-testid="settings-pane"]'
		);
		expect(carded.length).toBeGreaterThan(0);
	});

	test("a bare card paints nothing while the ordinary one does", async ({
		page,
	}) => {
		const bareCard = await ancestorBackgrounds(
			page.getByTestId("bare-card-textarea"),
			'[data-testid="settings-pane"]'
		);
		expect(bareCard).toEqual([]);
	});

	test("a bare card with its own affordances still paints no surface", async ({
		page,
	}) => {
		// The Memory tab's "Add to memory" shape: the textarea is not alone in the
		// card, it is joined by a status line and a submit button that belong to it.
		// That is still one setting, so the surface still goes — and everything in
		// the block aligns to the control's edge rather than to a card inset.
		const form = page.getByTestId("bare-form");
		const inCard = await ancestorBackgrounds(
			form,
			'[data-testid="settings-pane"]'
		);
		expect(inCard).toEqual([]);
		const pane = await page.getByTestId("settings-pane").boundingBox();
		const box = await form.locator("textarea").boundingBox();
		expect(pane).not.toBeNull();
		expect(box).not.toBeNull();
		if (pane && box) {
			expect(box.width).toBeGreaterThan(pane.width * 0.9);
		}
	});

	test("the rows around a bare row keep their card", async ({ page }) => {
		// The regression `bare` must not cause: breaking the card around the whole
		// group instead of just around the tall control.
		const groups = page
			.getByTestId("settings-pane")
			.locator('[data-slot="item-group"]');
		await expect(groups).toHaveCount(2);
		for (const group of await groups.all()) {
			const painted = await group.evaluate((n) => {
				const style = getComputedStyle(n);
				return style.backgroundColor !== "rgba(0, 0, 0, 0)";
			});
			expect(painted).toBe(true);
		}
	});

	test("the bare row's textarea spans the full column width", async ({
		page,
	}) => {
		// The other half of the old bug: squeezed into the row's right-hand
		// `actions` column, a textarea reads as a text field pretending to be one.
		const pane = await page
			.getByTestId("settings-pane")
			.boundingBox({ timeout: 5000 });
		const area = await page.getByTestId("bare-textarea").boundingBox();
		expect(pane).not.toBeNull();
		expect(area).not.toBeNull();
		if (pane && area) {
			expect(area.width).toBeGreaterThan(pane.width * 0.9);
		}
	});
});
