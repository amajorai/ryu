import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
	test(`reviews recover from a failed read in ${theme}`, async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({
			width: theme === "dark" ? 390 : 1100,
			height: 760,
		});
		await page.goto(`/reviews-state-proof.html?theme=${theme}`, {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByRole("alert")).toContainText(
			"Could not load reviews"
		);
		await expect(page.getByText("No reviews yet", { exact: true })).toHaveCount(
			0
		);
		await page.screenshot({
			path: resolve(
				import.meta.dirname,
				`../../../docs/proof/unfinished-feature-sweep-2026-09-22/reviews-error-${theme}.png`
			),
		});
		await page.getByRole("button", { name: "Try again", exact: true }).click();
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(
			page.getByText("No reviews yet", { exact: true })
		).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth
			)
		).toBe(false);
		expect(errors).toEqual([]);
		await page.screenshot({
			path: resolve(
				import.meta.dirname,
				`../../../docs/proof/unfinished-feature-sweep-2026-09-22/reviews-recovered-${theme}.png`
			),
		});
	});
}
