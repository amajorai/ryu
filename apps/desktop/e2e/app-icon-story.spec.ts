import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const proof = proofEvidencePath("app-icons-v2");
function manifestCount(roots: string[]) {
	return roots.reduce(
		(count, root) =>
			count +
			readdirSync(path.join(repository, root)).filter((name) =>
				existsSync(path.join(repository, root, name, "manifest.json"))
			).length,
		0
	);
}
const counts = {
	Apps: manifestCount(["apps-store"]),
	Plugins: manifestCount([
		"plugins-store/plugins",
		"plugins-store/lsp",
		"plugins-store/external_plugins",
	]),
};
test("all shipped icons render in light, dark, detail and narrow views", async ({
	page,
}) => {
	test.setTimeout(180_000);
	mkdirSync(proof, { recursive: true });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	// A shipped catalog must render on first paint without either icon CDN.
	await page.route("https://**", (route) => route.abort());
	await page.setViewportSize({ width: 1280, height: 960 });
	await page.goto("/app-icon-story.html");
	await expect(
		page.getByRole("heading", { name: "Marketplace", exact: true })
	).toBeVisible();
	for (const kind of ["Apps", "Plugins"] as const) {
		await page.getByRole("button", { name: kind, exact: true }).click();
		await expect(page.getByTestId("tile")).toHaveCount(counts[kind]);
		for (const theme of ["light", "dark"] as const) {
			if (theme === "dark") {
				await page.getByRole("button", { name: "Dark appearance" }).click();
			}
			const tiles = page.locator(
				'[data-testid="tile"] [data-app-icon="layered"]'
			);
			await expect(tiles).toHaveCount(counts[kind]);
			// Shipped icons are complete native renders, never an outline mask over a CSS tile.
			await expect(
				page.locator('[data-testid="tile"] [style*="mask-image"]')
			).toHaveCount(0);
			expect(await page.locator('[data-testid="tile"] canvas').count()).toBe(0);
			await expect
				.poll(
					() =>
						page
							.locator('[data-testid="tile"] img:visible')
							.evaluateAll((images) =>
								images.every(
									(image) =>
										image instanceof HTMLImageElement &&
										image.complete &&
										image.naturalWidth > 0
								)
							),
					{ timeout: 30_000 }
				)
				.toBe(true);
			await page.screenshot({
				path: path.join(proof, `${kind.toLowerCase()}-${theme}.png`),
				fullPage: true,
			});
		}
		await page.getByRole("button", { name: "Light appearance" }).click();
	}
	await page
		.getByRole("region", { name: "Artwork closeups" })
		.screenshot({ path: path.join(proof, "artwork-closeups.png") });
	await page.getByRole("button", { name: "Apps", exact: true }).click();
	await page.getByRole("button", { name: "Browser", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "Selected app" })
	).toBeVisible();
	await page.screenshot({
		path: path.join(proof, "browser-detail.png"),
		fullPage: false,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth)
	).toBeLessThanOrEqual(390);
	await page.screenshot({
		path: path.join(proof, "apps-narrow.png"),
		fullPage: false,
	});
	expect(errors).toEqual([]);
});
