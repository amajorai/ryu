import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/reorder-indicator-proof.html";

test("renders rounded caps on the fallback tab and sidebar drop markers", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	await expect(page.getByTestId("proof-status")).toHaveAttribute(
		"data-status",
		"pass"
	);
	await expect(page.locator("[data-reorder-line]")).toHaveCount(4);
	await expect
		.poll(() =>
			page
				.locator("[data-reorder-line]")
				.evaluateAll((indicators) =>
					indicators.every(
						(indicator) => getComputedStyle(indicator).borderRadius !== "0px"
					)
				)
		)
		.toBe(true);
});

test("slides rows apart instead of drawing a drop line", async ({ page }) => {
	await page.goto(STORY_URL);
	const row = (name: string) => page.locator(`[data-slide-row="${name}"]`);
	const offsetOf = (name: string) =>
		row(name).evaluate(
			(element) =>
				new DOMMatrixReadOnly(getComputedStyle(element).transform).m42
		);

	await page.getByRole("button", { name: "Drag Alpha onto Charlie" }).click();

	// Bravo and Charlie step up by Alpha's pitch; Alpha glides down past them;
	// Delta stays put. No line is drawn inside the list.
	await expect.poll(() => offsetOf("Bravo")).toBeLessThan(-10);
	await expect.poll(() => offsetOf("Charlie")).toBeLessThan(-10);
	await expect.poll(() => offsetOf("Alpha")).toBeGreaterThan(20);
	expect(await offsetOf("Delta")).toBe(0);
	await expect(
		page.getByTestId("slide-list").locator(".reorder-drop-indicator")
	).toHaveCount(0);

	// Releasing returns every row to rest.
	await page.getByRole("button", { name: "Release" }).click();
	await expect.poll(() => offsetOf("Bravo")).toBe(0);
	await expect.poll(() => offsetOf("Alpha")).toBe(0);
});
