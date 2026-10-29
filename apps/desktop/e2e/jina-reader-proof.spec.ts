import path from "node:path";
import { expect, test } from "@playwright/test";

test("renders Jina Reader with its bundled layered icon", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/jina-reader-proof.html", { waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("heading", { name: "Jina Reader" })
	).toBeVisible();
	const icon = page.locator('[data-app-icon="layered"] img').first();
	await expect(icon).toBeVisible();
	await expect
		.poll(() => icon.evaluate((image: HTMLImageElement) => image.naturalWidth))
		.toBeGreaterThan(0);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/jina-reader/jina-reader-listing.png"
		),
		fullPage: true,
	});
	await page
		.locator("html")
		.evaluate((element) => element.classList.add("dark"));
	const darkIcon = page.locator('[data-app-icon="layered"] img').last();
	await expect(darkIcon).toBeVisible();
	await expect
		.poll(() =>
			darkIcon.evaluate((image: HTMLImageElement) => image.naturalWidth)
		)
		.toBeGreaterThan(0);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/jina-reader/jina-reader-listing-dark.png"
		),
		fullPage: true,
	});
	expect(errors).toEqual([]);
});
