import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/dropdown-picker-proof.html";

test("proves the shared dropdown, text tabs, summary hover, and recent picker UI", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	await page.route("**/api/providers/**/credits", (route) =>
		route.fulfill({
			body: JSON.stringify({
				available: false,
				meters: [],
				provider_id: "openrouter",
				reason: null,
				retry_after_seconds: null,
			}),
			contentType: "application/json",
			status: 200,
		})
	);
	await page.setViewportSize({ height: 900, width: 1440 });
	await page.goto(STORY_URL);

	const menuTrigger = page.getByTestId("dropdown-proof-trigger");
	await menuTrigger.click();
	const menu = page.getByTestId("dropdown-proof-menu");
	await expect(menu).toBeVisible();

	const menuMetrics = await menu.evaluate((element) => ({
		clientHeight: element.clientHeight,
		maxHeight: getComputedStyle(element).maxHeight,
		maxWidth: getComputedStyle(element).maxWidth,
		overflowY: getComputedStyle(element).overflowY,
		scrollHeight: element.scrollHeight,
		maskImage: getComputedStyle(element).maskImage,
	}));
	expect(menuMetrics.scrollHeight).toBeGreaterThan(menuMetrics.clientHeight);
	expect(["auto", "scroll"]).toContain(menuMetrics.overflowY);
	expect(menuMetrics.maxHeight).not.toBe("none");
	expect(menuMetrics.maxWidth).not.toBe("none");
	expect(menuMetrics.maskImage).toContain("linear-gradient");

	await menu.getByTestId("dropdown-proof-row-0").hover();
	await expect
		.poll(() =>
			menu
				.getByTestId("dropdown-proof-row-0")
				.locator('[data-slot="dropdown-proof-label"]')
				.evaluate(
					(element) => element.firstElementChild?.getAnimations().length ?? 0
				)
		)
		.toBeGreaterThan(0);

	for (let attempt = 0; attempt < 12; attempt++) {
		if ((await menu.getByTestId("dropdown-proof-row-64").count()) > 0) {
			break;
		}
		await menu.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
			element.dispatchEvent(new Event("scroll"));
		});
		await page.waitForTimeout(250);
	}
	await expect
		.poll(() => menu.getByTestId("dropdown-proof-row-64").count())
		.toBe(1);

	await page.keyboard.press("Escape");

	const activeTab = page.getByTestId("text-tab-active");
	const inactiveTab = page.getByTestId("text-tab-inactive");
	await expect(activeTab).toHaveAttribute("data-active");
	const tabColors = await Promise.all(
		[activeTab, inactiveTab].map((tab) =>
			tab.evaluate((element) => ({
				background: getComputedStyle(element).backgroundColor,
				color: getComputedStyle(element).color,
			}))
		)
	);
	expect(tabColors[0]?.color).not.toBe(tabColors[1]?.color);
	expect(tabColors[0]?.background).toBe(tabColors[1]?.background);

	const summaryAction = page.getByTestId("pinned-summary-action");
	await summaryAction.hover();
	await expect
		.poll(() =>
			summaryAction.evaluate(
				(element) => getComputedStyle(element).backgroundColor
			)
		)
		.toBe("rgba(0, 0, 0, 0)");

	await page.getByTestId("model-picker-trigger").click();
	const picker = page.locator('[data-slot="command-list"]');
	await expect(picker).toBeVisible();
	await expect(page.getByTestId("recent-count")).toHaveText("5 recent");
	const recentRows = picker.locator('[data-testid^="recent-model-row-"]');
	await expect(recentRows).toHaveCount(5);
	await expect(
		picker.locator('[data-composer-effort-meter="true"]')
	).toHaveCount(5);

	const recentRow = recentRows.first();
	await recentRow.hover();
	const removeButton = recentRow.getByRole("button", {
		name: /Remove .* from recent/,
	});
	await expect(removeButton).toBeVisible();
	await expect(
		picker.locator('[data-composer-effort-meter="true"]').first()
	).toHaveAttribute("title", "Effort: High");
	await removeButton.click();
	await expect(page.getByTestId("recent-count")).toHaveText("4 recent");
	await picker.getByRole("option", { name: "OpenRouter" }).click();
	const backOption = picker.getByRole("option", {
		name: "Back to Choose provider and model",
	});
	await expect(backOption).toBeVisible();
	await expect(picker.getByRole("option").first()).toHaveAccessibleName(
		"Back to Choose provider and model"
	);
	await expect(
		picker.getByRole("button", { name: /Back to Choose provider and model/ })
	).toHaveCount(0);
	await backOption.click();
	await picker.getByRole("option", { name: "OpenRouter" }).click();
	await picker.getByRole("option", { name: /^Model/ }).click();
	await expect(
		picker.getByRole("option", { name: "Back to OpenRouter" })
	).toBeVisible();
	await expect(picker.getByText("Auto Code", { exact: true })).toBeVisible();
	await page.screenshot({
		path: "test-results/dropdown-picker-pareto-code-proof.png",
		fullPage: true,
	});
	expect(pageErrors).toEqual([]);
	expect(consoleErrors).toEqual([]);
});

test("shows OpenRouter Pareto Code as Auto Code in the shared picker", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	await page.route("**/api/providers/**/credits", (route) =>
		route.fulfill({
			body: JSON.stringify({
				available: false,
				meters: [],
				provider_id: "openrouter",
				reason: null,
				retry_after_seconds: null,
			}),
			contentType: "application/json",
			status: 200,
		})
	);
	await page.setViewportSize({ height: 900, width: 1440 });
	await page.goto(STORY_URL);

	await page.getByTestId("model-picker-trigger").click();
	const picker = page.locator('[data-slot="command-list"]');
	await expect(picker).toBeVisible();
	await picker.getByRole("option", { name: "OpenRouter" }).click();
	const backOption = picker.getByRole("option", {
		name: "Back to Choose provider and model",
	});
	await expect(backOption).toBeVisible();
	await expect(picker.getByRole("option").first()).toHaveAccessibleName(
		"Back to Choose provider and model"
	);
	await expect(
		picker.getByRole("button", { name: /Back to Choose provider and model/ })
	).toHaveCount(0);
	await backOption.click();
	await picker.getByRole("option", { name: "OpenRouter" }).click();
	await picker.getByRole("option", { name: /^Model/ }).click();
	await expect(
		picker.getByRole("option", { name: "Back to OpenRouter" })
	).toBeVisible();
	await expect(picker.getByText("Auto Code", { exact: true })).toBeVisible();
	await page.screenshot({
		path: "test-results/dropdown-picker-pareto-code-proof.png",
		fullPage: true,
	});
	expect(pageErrors).toEqual([]);
	expect(consoleErrors).toEqual([]);
});
