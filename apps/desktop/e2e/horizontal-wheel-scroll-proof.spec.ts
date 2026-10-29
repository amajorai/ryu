import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/horizontal-wheel-scroll-proof.html";

test("vertical wheel input moves horizontal-only rows", async ({ page }) => {
	await page.goto(STORY_URL);

	const horizontal = page.getByTestId("horizontal-wheel-proof");
	const vertical = page.getByTestId("vertical-wheel-proof");
	await expect(horizontal).toBeVisible();

	const horizontalMetrics = await horizontal.evaluate((element) => ({
		clientHeight: element.clientHeight,
		clientWidth: element.clientWidth,
		overflowX: getComputedStyle(element).overflowX,
		overflowY: getComputedStyle(element).overflowY,
		scrollHeight: element.scrollHeight,
		scrollWidth: element.scrollWidth,
	}));
	expect(horizontalMetrics.scrollWidth).toBeGreaterThan(
		horizontalMetrics.clientWidth
	);
	expect(horizontalMetrics.scrollHeight).toBeLessThanOrEqual(
		horizontalMetrics.clientHeight + 1
	);
	expect(horizontalMetrics.overflowX).toBe("auto");
	expect(horizontalMetrics.overflowY).toBe("hidden");

	const initialLeft = await horizontal.evaluate(
		(element) => element.scrollLeft
	);
	const horizontalBox = await horizontal.boundingBox();
	if (!horizontalBox) {
		throw new Error("Horizontal proof geometry was not available");
	}
	await page.mouse.move(
		horizontalBox.x + horizontalBox.width / 2,
		horizontalBox.y + horizontalBox.height / 2
	);
	await page.mouse.wheel(0, 360);
	await expect
		.poll(() => horizontal.evaluate((element) => element.scrollLeft))
		.toBeGreaterThan(initialLeft);

	const movedRight = await horizontal.evaluate((element) => element.scrollLeft);
	await page.mouse.wheel(0, -180);
	await expect
		.poll(() => horizontal.evaluate((element) => element.scrollLeft))
		.toBeLessThan(movedRight);
	await expect(page.getByTestId("horizontal-wheel-position")).toContainText(
		"Scroll position:"
	);

	const verticalBefore = await vertical.evaluate((element) => ({
		scrollLeft: element.scrollLeft,
		scrollTop: element.scrollTop,
	}));
	const verticalBox = await vertical.boundingBox();
	if (!verticalBox) {
		throw new Error("Vertical proof geometry was not available");
	}
	await page.mouse.move(
		verticalBox.x + verticalBox.width / 2,
		verticalBox.y + verticalBox.height / 2
	);
	await page.mouse.wheel(0, 120);
	await expect
		.poll(() => vertical.evaluate((element) => element.scrollTop))
		.toBeGreaterThan(verticalBefore.scrollTop);
	expect(await vertical.evaluate((element) => element.scrollLeft)).toBe(
		verticalBefore.scrollLeft
	);

	await page.screenshot({
		path: test.info().outputPath("horizontal-wheel-scroll-proof.png"),
		fullPage: true,
	});
});
