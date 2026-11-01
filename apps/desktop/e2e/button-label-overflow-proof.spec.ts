import { expect, test } from "@playwright/test";

const STORY_URL = "/button-label-overflow-proof.html";
// FadeOverflowText masks a clipped label with the `fade-text-edge` utility;
// `text-fade-edge` is only a legacy alias that no shared control applies.

const CASES = [
	{
		id: "button-auto",
		selector: "span",
		text: "Jiawei Zhang-Alexander Longname",
	},
	{
		id: "button-icon",
		selector: "span",
		text: "feature/very-long-branch-name-for-overflow-proof",
	},
	{
		id: "select",
		selector: '[data-slot="select-value"]',
		text: "feature/very-long-branch-name-for-overflow-proof",
	},
	{
		id: "toggle",
		selector: "span",
		text: "/Users/jiawei/Documents/Projects/very-long-project-folder",
	},
	{
		id: "custom",
		selector: "span",
		text: "/Users/jiawei/Documents/Projects/very-long-project-folder",
	},
] as const;

test("shared controls fade their clipped labels at their max width", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);
	await page.waitForLoadState("networkidle");

	for (const item of CASES) {
		const trigger = page.getByTestId(`${item.id}-trigger`);
		const label = trigger.locator(item.selector).first();
		const inner = label.locator("span").first();

		await expect(label).toHaveText(item.text);
		await expect
			.poll(() =>
				label.evaluate((element) => ({
					clipped: element.scrollWidth > element.clientWidth + 1,
					faded: element.classList.contains("fade-text-edge"),
				}))
			)
			.toEqual({ clipped: true, faded: true });

		await label.hover();
		await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
			item.text
		);
		await expect
			.poll(() => inner.evaluate((element) => element.getAnimations().length))
			.toBeGreaterThan(0);
		await page.mouse.move(1, 1);
	}

	const proofLabel = page
		.getByTestId("button-auto-trigger")
		.locator("span")
		.first();
	await proofLabel.hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
		"Jiawei Zhang-Alexander Longname"
	);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("button-select-overflow-fade-proof.png"),
	});
});

test("a short label stays crisp across the shared button primitive", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.waitForLoadState("networkidle");
	const label = page.getByTestId("short-trigger").locator("span").first();

	await expect(label).toHaveText("Project");
	await expect(label).not.toHaveClass(/fade-text-edge/);
	await label.hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
});

test("select value overflow state follows selection changes", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.waitForLoadState("networkidle");
	const trigger = page.getByTestId("select-trigger");
	const label = trigger.locator('[data-slot="select-value"]');

	await trigger.click();
	await page.getByRole("option", { name: "Project", exact: true }).click();
	await expect(label).toHaveText("Project");
	await expect(label).not.toHaveClass(/fade-text-edge/);
	await label.hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);

	await page.mouse.move(1, 1);
	await trigger.click();
	await page
		.getByRole("option", {
			name: "feature/very-long-branch-name-for-overflow-proof",
			exact: true,
		})
		.click();
	await expect(label).toHaveText(
		"feature/very-long-branch-name-for-overflow-proof"
	);
	await expect
		.poll(() =>
			label.evaluate((element) => ({
				clipped: element.scrollWidth > element.clientWidth + 1,
				faded: element.classList.contains("fade-text-edge"),
			}))
		)
		.toEqual({
			clipped: true,
			faded: true,
		});

	await label.hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
		"feature/very-long-branch-name-for-overflow-proof"
	);
});
