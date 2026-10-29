import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const PROOF_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../docs/proof/wallpaper-backgrounds"
);

test.beforeEach(async ({ page }) => {
	await page.goto("/desktop-startup-selection-story.html", {
		waitUntil: "commit",
	});
	await expect(page.locator("body")).toHaveAttribute(
		"data-harness-ready",
		"1",
		{
			timeout: 30_000,
		}
	);
	await expect(page.getByTestId("desktop-startup-chooser")).toBeVisible({
		timeout: 30_000,
	});
});

test("shows the macOS-like account chooser with signed-in accounts", async ({
	page,
}) => {
	await expect(page.getByTestId("startup-account-step")).toBeVisible();
	await expect(page.getByText("Jia Wei Ng", { exact: true })).toBeVisible();
	await expect(page.getByText("Studio account", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Add account" })).toBeVisible();
});

test("continues from account selection to node selection", async ({ page }) => {
	await page.getByText("Studio account", { exact: true }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();

	await expect(page.getByTestId("startup-node-step")).toBeVisible();
	await expect(page.getByText("local", { exact: true })).toBeVisible();
	await expect(page.getByText("Studio Mac", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("switch", { name: "Use as default" })
	).toBeVisible();
});

test("marketplace defaults and plugin wallpapers render and keep their credits", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	mkdirSync(PROOF_DIR, { recursive: true });
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await expect(page.getByText("Jia Wei Ng", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Add account" })).toBeVisible();
	await expect(page.locator("[data-wallpaper-id]")).toHaveAttribute(
		"data-wallpaper-id",
		"backdrop:@example/wallpapers:dawn"
	);

	await page
		.getByRole("button", { name: "Choose wallpaper", exact: true })
		.click();
	await page.getByRole("tab", { name: "Animated" }).click();
	await page.getByRole("tab", { name: "Marketplace" }).click();
	const meshGradientTile = page.getByTestId(
		"backdrop-tile-com.ryu.marketplace-defaults:mesh-gradient"
	);
	const dynamicGridTile = page.getByTestId(
		"backdrop-tile-com.ryu.marketplace-defaults:dynamic-grid"
	);
	await expect(meshGradientTile).toContainText("By Remocn");
	await expect(dynamicGridTile).toContainText("By Remocn");
	await meshGradientTile.click();
	await expect(page.locator("[data-wallpaper-id]")).toHaveAttribute(
		"data-wallpaper-id",
		"backdrop:com.ryu.marketplace-defaults:mesh-gradient"
	);
	await expect(
		page.getByTestId("backdrop-customize").getByRole("link", { name: "Remocn" })
	).toHaveAttribute("href", "https://www.remocn.dev/docs/components");
	await page.screenshot({
		path: path.join(PROOF_DIR, "marketplace-default-shaders.png"),
		fullPage: true,
	});

	await dynamicGridTile.click();
	await expect(page.locator("[data-wallpaper-id]")).toHaveAttribute(
		"data-wallpaper-id",
		"backdrop:com.ryu.marketplace-defaults:dynamic-grid"
	);
	await page.screenshot({
		path: path.join(PROOF_DIR, "marketplace-dynamic-grid.png"),
		fullPage: true,
	});

	const wallpaperTile = page.getByTestId(
		"backdrop-tile-@example/wallpapers:aurora"
	);
	await expect(wallpaperTile).toBeVisible();
	await expect(wallpaperTile).toContainText("By PatternCraft");
	await wallpaperTile.click();

	await expect(page.getByTestId("backdrop-customize")).toBeVisible();
	await expect(
		page
			.getByTestId("backdrop-customize")
			.getByRole("link", { name: "PatternCraft" })
	).toHaveAttribute("href", "https://example.com/patterncraft/aurora");
	await expect(page.locator("[data-wallpaper-id]")).toHaveAttribute(
		"data-wallpaper-id",
		"backdrop:@example/wallpapers:aurora"
	);
	await page.screenshot({
		path: path.join(PROOF_DIR, "marketplace-wallpaper-picker.png"),
		fullPage: true,
	});

	await page
		.getByRole("button", { name: "Choose wallpaper", exact: true })
		.click();
	await expect(page.getByTestId("desktop-startup-chooser")).toBeVisible();
	await expect(
		page
			.getByTestId("desktop-startup-chooser")
			.getByRole("link", { name: "PatternCraft" })
	).toBeVisible();
	await expect(page.locator("[data-wallpaper-id]")).toHaveAttribute(
		"data-wallpaper-id",
		"backdrop:@example/wallpapers:aurora"
	);
	await page.screenshot({
		path: path.join(PROOF_DIR, "marketplace-wallpaper-startup-chooser.png"),
		fullPage: true,
	});
	await page.getByText("Studio account", { exact: true }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(page.getByTestId("startup-node-step")).toBeVisible();
	await expect(page.getByText("Studio Mac", { exact: true })).toBeVisible();
	await expect(
		page
			.getByTestId("desktop-startup-chooser")
			.getByRole("link", { name: "PatternCraft" })
	).toBeVisible();
	await page.screenshot({
		path: path.join(PROOF_DIR, "marketplace-wallpaper-node-chooser.png"),
		fullPage: true,
	});
	await expect(pageErrors).toEqual([]);
});

test("lists the full marketplace catalog and installs CSS through its host adapter", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	mkdirSync(PROOF_DIR, { recursive: true });
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));

	await page
		.getByRole("button", { name: "Choose wallpaper", exact: true })
		.click();
	await page.getByRole("tab", { name: "Animated" }).click();
	await page.getByRole("tab", { name: "Marketplace" }).click();
	await expect(page.getByTestId("marketplace-wallpaper-count")).toHaveText(
		"263 of 263 wallpapers"
	);
	const cssBackdrops = page.locator(
		'[data-backdrop-renderer="marketplace-css"]'
	);
	await expect(cssBackdrops).toHaveCount(259);
	const unpaintedBackdrops = await cssBackdrops.evaluateAll(
		(elements) =>
			elements.filter((element) => {
				const style = window.getComputedStyle(element);
				return (
					style.backgroundImage === "none" &&
					style.maskImage === "none" &&
					style.backgroundColor === "rgba(0, 0, 0, 0)"
				);
			}).length
	);
	expect(unpaintedBackdrops).toBe(0);
	await page.screenshot({
		path: path.join(PROOF_DIR, "marketplace-patterncraft-catalog.png"),
	});

	const search = page.getByTestId("marketplace-wallpaper-search");
	await search.fill("PatternCraft Adapter Grid");
	await expect(page.getByTestId("marketplace-wallpaper-count")).toHaveText(
		"1 of 263 wallpapers"
	);
	const contributedTile = page.getByTestId(
		"backdrop-tile-@example/wallpapers:patterncraft-grid"
	);
	await contributedTile.click();
	const contributedWallpaper = page.locator(
		'[data-wallpaper-id="backdrop:@example/wallpapers:patterncraft-grid"] [data-backdrop-renderer="marketplace-css"]'
	);
	await expect(contributedWallpaper).toBeVisible();
	await expect(
		page
			.getByTestId("backdrop-customize")
			.getByRole("link", { name: "PatternCraft" })
	).toHaveAttribute("href", "https://patterncraft.fun/");
	const contributedImage = await contributedWallpaper.evaluate(
		(element) => window.getComputedStyle(element).backgroundImage
	);
	expect(contributedImage).toContain("radial-gradient");
	await page.screenshot({
		path: path.join(PROOF_DIR, "marketplace-patterncraft-adapter-install.png"),
	});

	await search.fill("Top Gradient Radial");
	const bundledTile = page.getByTestId(
		"backdrop-tile-com.ryu.patterncraft:top-gradient-radial"
	);
	await bundledTile.click();
	await expect(page.locator("[data-wallpaper-id]")).toHaveAttribute(
		"data-wallpaper-id",
		"backdrop:com.ryu.patterncraft:top-gradient-radial"
	);
	const bundledImage = await page
		.locator(
			'[data-wallpaper-id="backdrop:com.ryu.patterncraft:top-gradient-radial"] [data-backdrop-renderer="marketplace-css"]'
		)
		.evaluate((element) => window.getComputedStyle(element).backgroundImage);
	expect(bundledImage).toContain("radial-gradient");
	await page.screenshot({
		path: path.join(
			PROOF_DIR,
			"marketplace-patterncraft-installed-wallpaper.png"
		),
	});

	await page
		.getByRole("button", { name: "Choose wallpaper", exact: true })
		.click();
	await expect(page.getByTestId("desktop-startup-chooser")).toBeVisible();
	await page
		.getByRole("button", { name: "Choose wallpaper", exact: true })
		.click();
	await page.getByRole("tab", { name: "Animated" }).click();
	await page.getByRole("tab", { name: "Marketplace" }).click();
	await page
		.getByTestId("marketplace-wallpaper-search")
		.fill("Top Gradient Radial");
	await expect(
		page.getByTestId("backdrop-tile-com.ryu.patterncraft:top-gradient-radial")
	).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator("[data-wallpaper-id]")).toHaveAttribute(
		"data-wallpaper-id",
		"backdrop:com.ryu.patterncraft:top-gradient-radial"
	);
	await expect(pageErrors).toEqual([]);
});
