import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORAGE_KEY = "ryu.tabs.layout.proof";
const STORY_URL = "/tabs-layout-proof.html";

test("verifies overflow, menu controls, context reuse, and persisted layout", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);
	await page.evaluate(
		(storageKey) => localStorage.removeItem(storageKey),
		STORAGE_KEY
	);
	await page.reload();

	const moreTrigger = page.locator('[data-tabs-more-trigger="true"]');
	await expect(moreTrigger).toHaveAttribute("data-tabs-more-visible", "true");
	const referenceTabTrigger = page
		.locator("[data-tabs-managed-trigger]")
		.first();
	const mutedText = page.locator("p.text-muted-foreground").first();
	const [moreMetrics, tabMetrics, mutedColor] = await Promise.all([
		moreTrigger.evaluate((element) => {
			const styles = getComputedStyle(element);
			return {
				borderRadius: styles.borderTopLeftRadius,
				color: styles.color,
				fontSize: styles.fontSize,
				height: element.getBoundingClientRect().height,
				paddingBottom: styles.paddingBottom,
				paddingTop: styles.paddingTop,
				svgCount: element.querySelectorAll("svg").length,
				text: element.textContent?.trim() ?? "",
			};
		}),
		referenceTabTrigger.evaluate((element) => {
			const styles = getComputedStyle(element);
			return {
				borderRadius: styles.borderTopLeftRadius,
				fontSize: styles.fontSize,
				height: element.getBoundingClientRect().height,
				paddingBottom: styles.paddingBottom,
				paddingTop: styles.paddingTop,
			};
		}),
		mutedText.evaluate((element) => getComputedStyle(element).color),
	]);
	expect(moreMetrics.text).toMatch(/^\d+ more$/u);
	expect(moreMetrics.svgCount).toBe(0);
	expect(moreMetrics.color).toBe(mutedColor);
	expect(moreMetrics).toMatchObject(tabMetrics);

	await moreTrigger.click();
	const commandInput = page.getByRole("combobox", { name: "Search tabs" });
	await expect(commandInput).toBeVisible();
	const menu = page.locator('[data-slot="dropdown-menu-content"]');
	const commandInputGroup = page.locator(
		'[data-slot="command-input-wrapper"] [data-slot="input-group"]'
	);
	const commandGroupHeading = page.locator("[cmdk-group-heading]").first();
	const command = menu.locator('[data-slot="command"]');
	await expect(menu).toBeVisible();
	await expect(menu).toHaveCSS("border-top-left-radius", "14px");
	await expect(menu).toHaveCSS("padding", "0px");
	await expect(command).toHaveCSS("padding", "0px");
	await expect(commandInputGroup).toHaveCSS(
		"background-color",
		"rgba(0, 0, 0, 0)"
	);
	await expect(commandGroupHeading).toHaveCSS(
		"background-color",
		"rgba(0, 0, 0, 0)"
	);
	const transparentBoxShadow =
		/^(none|rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(?:, rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)*)$/u;
	const [inputGroupShadow, inputShadow] = await Promise.all([
		commandInputGroup.evaluate(
			(element) => getComputedStyle(element).boxShadow
		),
		commandInput.evaluate((element) => getComputedStyle(element).boxShadow),
	]);
	expect(inputGroupShadow).toMatch(transparentBoxShadow);
	expect(inputShadow).toMatch(transparentBoxShadow);
	await page.screenshot({
		path: testInfo.outputPath("tabs-layout-more-proof.png"),
	});
	await expect(page.locator("[data-tabs-menu-key]")).toHaveCount(7);
	await commandInput.fill("Billing");
	await expect(
		page.locator("[data-tabs-menu-key]").filter({ hasText: "Billing" })
	).toBeVisible();
	await expect(
		page.locator("[data-tabs-menu-key]").filter({ hasText: "Overview" })
	).toBeHidden();
	await commandInput.fill("");

	await page.keyboard.press("Escape");
	const visibleTriggers = page.locator("[data-tabs-managed-trigger]");
	const firstVisibleTrigger = visibleTriggers.nth(1);
	const secondVisibleTrigger = visibleTriggers.nth(0);
	await expect(secondVisibleTrigger).toBeVisible();

	const initialOrder = await page.getByTestId("stored-order").innerText();
	const sourceBox = await firstVisibleTrigger.boundingBox();
	const targetBox = await secondVisibleTrigger.boundingBox();
	if (!(sourceBox && targetBox)) {
		throw new Error("Visible tab geometry was not available for drag proof");
	}
	await page.mouse.move(
		sourceBox.x + sourceBox.width / 2,
		sourceBox.y + sourceBox.height / 2
	);
	await page.mouse.down();
	await page.waitForTimeout(100);
	await page.mouse.move(
		targetBox.x + targetBox.width * 0.25,
		targetBox.y + targetBox.height / 2,
		{ steps: 8 }
	);
	// The hovered tab slides aside to open the gap; no drop line is drawn.
	await expect
		.poll(() =>
			secondVisibleTrigger.evaluate(
				(element) =>
					new DOMMatrixReadOnly(getComputedStyle(element).transform).m41
			)
		)
		.toBeGreaterThan(0);
	await expect(page.locator("[data-tabs-drop-indicator]")).toHaveCount(0);
	// A real drag keeps firing dragover while the pointer rests; Playwright's
	// emulated one does not, so nudge once to re-target the slid-in tab.
	await page.mouse.move(
		targetBox.x + targetBox.width * 0.25 + 1,
		targetBox.y + targetBox.height / 2
	);
	await page.mouse.up();
	await expect
		.poll(() => page.getByTestId("stored-order").innerText())
		.not.toBe(initialOrder);

	await secondVisibleTrigger.click({ button: "right" });
	const contextMenu = page.locator('[data-slot="context-menu-content"]');
	await expect(contextMenu).toBeVisible();
	await expect(
		contextMenu.getByRole("combobox", { name: "Search tabs" })
	).toBeVisible();
	await page.keyboard.press("Escape");

	await moreTrigger.click();
	await expect(commandInput).toBeVisible();
	await commandInput.fill("Overview");
	await expect(
		page.getByRole("button", { name: "More actions for Overview" })
	).toBeVisible();
	await page.getByRole("button", { name: "More actions for Overview" }).click();
	await page.getByRole("menuitem", { name: "Hide Overview" }).click();
	await page.keyboard.press("Escape");

	await expect(page.locator('[data-testid="hidden-keys"]')).not.toHaveText(
		"none"
	);
	await page.reload();
	await expect(page.locator('[data-testid="hidden-keys"]')).not.toHaveText(
		"none"
	);

	await page.locator('[data-tabs-more-trigger="true"]').click();
	const hiddenOverview = page
		.locator('[data-tabs-menu-hidden="true"]')
		.filter({ hasText: "Overview" });
	await expect(hiddenOverview).toBeVisible();
	await expect(hiddenOverview).toHaveCSS("opacity", "0.5");
	await expect(
		hiddenOverview.locator('[data-tabs-menu-hidden-indicator="true"]')
	).toHaveCount(1);
	await page.screenshot({
		path: testInfo.outputPath("tabs-layout-hidden-tab-proof.png"),
	});
	await page.getByRole("button", { name: "Reset tabs" }).click();
	await expect(page.locator('[data-testid="hidden-keys"]')).toHaveText("none");
	await expect(page.locator('[data-testid="stored-order"]')).not.toHaveText(
		"none"
	);
});

test("verifies component-level edge arrows when layout management is disabled", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);
	const proof = page.getByTestId("overflow-controls-proof");
	const list = proof.getByTestId("overflow-tabs-list");
	await expect(list).toHaveAttribute("data-tabs-overflow", "true");
	await expect(list).toHaveAttribute("data-edges", "end");
	await expect(list).toHaveCSS("overflow-y", "hidden");
	await expect(list.locator('[role="tab"]')).toHaveCount(7);

	const controls = page.locator('[data-slot="tabs-overflow-controls"]');
	await expect(controls).toBeVisible();
	const backward = controls.getByRole("button", { name: "Scroll tabs left" });
	const forward = controls.getByRole("button", { name: "Scroll tabs right" });
	await expect(backward).toBeDisabled();
	await expect(forward).toBeEnabled();
	await expect(backward).toHaveClass(/rounded-l-full/);
	await expect(forward).toHaveClass(/rounded-r-full/);
	const listId = await list.getAttribute("id");
	expect(listId).toBeTruthy();
	expect(await forward.getAttribute("aria-controls")).toBe(listId);
	expect(
		await backward.evaluate((element) => getComputedStyle(element).opacity)
	).toBe("0");

	const team = list.getByRole("tab", { name: "Team" });
	await team.evaluate((element) => {
		if (!(element instanceof HTMLElement)) {
			throw new Error("Fixture tab must be a native HTML element");
		}
		element.click();
	});
	await expect(team).toHaveAttribute("aria-selected", "true");
	await expect(list).toHaveAttribute("data-edges", "both");
	await expect(backward).toBeEnabled();
	await expect(forward).toBeEnabled();
	const indicator = list.locator('[data-slot="tabs-indicator"]');
	await expect
		.poll(async () => {
			const [indicatorLeft, teamLeft] = await Promise.all([
				indicator.evaluate((element) => element.getBoundingClientRect().left),
				team.evaluate((element) => element.getBoundingClientRect().left),
			]);
			return Math.abs(indicatorLeft - teamLeft);
		})
		.toBeLessThan(1);

	await proof.screenshot({
		path: testInfo.outputPath("tabs-layout-overflow-arrows-proof.png"),
	});

	const before = await list.evaluate((element) => element.scrollLeft);
	await forward.click();
	await expect
		.poll(() => list.evaluate((element) => element.scrollLeft), {
			timeout: 10_000,
		})
		.toBeGreaterThan(before);
	await expect(backward).toBeEnabled();
});

test("reveals selected and focused tabs that start outside the strip", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const list = page.getByTestId("overflow-tabs-list");
	const reports = list.getByRole("tab", { name: "Reports" });
	const initialScrollLeft = await list.evaluate(
		(element) => element.scrollLeft
	);

	await reports.evaluate((element) => {
		if (!(element instanceof HTMLElement)) {
			throw new Error("Fixture tab must be a native HTML element");
		}
		element.click();
	});
	await expect(reports).toHaveAttribute("aria-selected", "true");
	await expect
		.poll(() => list.evaluate((element) => element.scrollLeft), {
			timeout: 10_000,
		})
		.toBeGreaterThan(initialScrollLeft);
	const selectedBounds = await Promise.all([
		list.evaluate((element) => element.getBoundingClientRect().left),
		reports.evaluate((element) => element.getBoundingClientRect().left),
	]);
	expect(selectedBounds[1]).toBeGreaterThanOrEqual(selectedBounds[0] + 30);

	const overview = list.getByRole("tab", { name: "Overview" });
	const reportScrollLeft = await list.evaluate((element) => element.scrollLeft);
	await overview.evaluate((element) => {
		if (!(element instanceof HTMLElement)) {
			throw new Error("Overview tab must be a native HTML element");
		}
		element.focus({ preventScroll: true });
	});
	await expect
		.poll(() => list.evaluate((element) => element.scrollLeft), {
			timeout: 10_000,
		})
		.toBeLessThan(reportScrollLeft);
	await expect(list).toHaveAttribute("data-edges", "end");
});
