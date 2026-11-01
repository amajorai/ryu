import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/keyboard-shortcuts-search-proof.html";

test("keeps the filter above an independently scrolling shortcut list", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const filter = page.getByTestId("keyboard-shortcuts-filter");
	const resetAll = page.getByTestId("keyboard-shortcuts-reset-all");
	const scroller = page.getByTestId("keyboard-shortcuts-scroll");
	await expect(filter).toBeVisible();
	await expect(filter).toHaveAttribute("placeholder", "Search");
	await expect(resetAll).toBeVisible();
	await expect(resetAll).toHaveText("Reset all to defaults");
	// 57c69af9a9 (Ryu Quiet settings sweep) made Reset all a quiet outline
	// button instead of the primary fill.
	await expect(resetAll).toHaveClass(/border-border bg-background/);
	await expect(resetAll).not.toHaveClass(/bg-primary/);
	await expect(scroller).toBeVisible();

	const metrics = await filter.evaluate((element) => {
		const list = document.querySelector<HTMLElement>(
			'[data-testid="keyboard-shortcuts-scroll"]'
		);
		const reset = document.querySelector<HTMLElement>(
			'[data-testid="keyboard-shortcuts-reset-all"]'
		);
		if (!(list && reset)) {
			return null;
		}
		const filterBox = element.getBoundingClientRect();
		const listBox = list.getBoundingClientRect();
		const resetBox = reset.getBoundingClientRect();
		return {
			filterHeight: filterBox.height,
			hasDefaultSize: element.classList.contains("h-9"),
			listTop: listBox.top,
			filterBottom: filterBox.bottom,
			resetTop: resetBox.top,
			hasOverflow: list.scrollHeight > list.clientHeight,
			isScrollFade: list.classList.contains("scroll-fade"),
		};
	});
	if (!metrics) {
		throw new Error("Keyboard shortcut layout did not render");
	}
	// 57c69af9a9 moved the filter from the lg Input (h-10) to the default
	// Input size (h-9, 36px).
	expect(metrics.filterHeight).toBe(36);
	expect(metrics.hasDefaultSize).toBe(true);
	expect(metrics.resetTop).toBeLessThan(metrics.listTop);
	expect(metrics.listTop).toBeGreaterThanOrEqual(metrics.filterBottom);
	expect(metrics.isScrollFade).toBe(true);
	expect(metrics.hasOverflow).toBe(true);

	await resetAll.click();
	const resetDialog = page.getByRole("heading", {
		name: "Reset all shortcuts to defaults?",
	});
	await expect(resetDialog).toBeVisible();
	await page
		.getByRole("button", { name: "Reset all to defaults", exact: true })
		.last()
		.click();
	await expect(resetDialog).not.toBeVisible();
	await expect(resetAll).toBeVisible();

	await scroller.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	expect(
		await scroller.evaluate((element) => element.scrollTop)
	).toBeGreaterThan(0);
	await expect(page.getByTestId("proof-status")).toHaveAttribute(
		"data-status",
		"pass"
	);

	await filter.fill("sidebar");
	await expect(page.getByText("Toggle Sidebar", { exact: true })).toBeVisible();
	await expect(page.getByText("New Chat", { exact: true })).not.toBeVisible();

	await filter.fill("quick reply");
	await expect(
		page.getByText("Quick reply click modifier", { exact: true })
	).toBeVisible();
	const quickReplyModifier = page.getByRole("combobox", {
		name: "Quick reply click modifier",
	});
	await expect(quickReplyModifier).toContainText("Alt / Option");
	await quickReplyModifier.click();
	await page.getByRole("option", { name: "Shift" }).click();
	await expect(quickReplyModifier).toContainText("Shift");
	await page.evaluate(() =>
		localStorage.removeItem("ryu:quick-reply-modifier")
	);

	await filter.fill("quick preview");
	await expect(
		page.getByText("Quick preview click modifier", { exact: true })
	).toBeVisible();
	const quickPreviewModifier = page.getByRole("combobox", {
		name: "Quick preview click modifier",
	});
	await expect(quickPreviewModifier).toContainText("Shift");
	await quickPreviewModifier.click();
	await page.getByRole("option", { name: "Control" }).click();
	await expect(quickPreviewModifier).toContainText("Control");
	await page.evaluate(() =>
		localStorage.removeItem("ryu:quick-preview-modifier")
	);

	await filter.fill("no shortcut matches this phrase");
	await expect(resetAll).toBeVisible();
});
