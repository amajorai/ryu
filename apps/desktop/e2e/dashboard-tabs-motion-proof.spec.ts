import { expect, test } from "@playwright/test";

test("dashboard cards and tab split feedback settle into the intended state", async ({
	page,
}, testInfo) => {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => consoleErrors.push(String(error)));

	await page.goto("/dashboard-tabs-motion-proof.html");
	await page.setViewportSize({ width: 1280, height: 1200 });
	await expect(page).toHaveTitle("Dashboard and tab motion proof");
	await expect(page.getByTestId("dashboard-motion-proof")).toBeVisible();
	await expect(page.getByTestId("split-demo-surface")).toBeVisible();
	await expect(page.getByTestId("split-status")).toHaveText("One pane");
	await expect(page.locator('[data-dashboard-interaction="idle"]')).toHaveCount(
		3
	);

	// WidgetCard marks its header with `data-widget-drag-handle` (the react-grid-layout
	// handle selector in DashboardGrid); there is no `.widget-drag-handle` class.
	const widgetHandle = page.locator("[data-widget-drag-handle]").first();
	const widgetBox = await widgetHandle.boundingBox();
	if (!widgetBox) {
		throw new Error("dashboard widget did not receive geometry");
	}
	await page.mouse.move(
		widgetBox.x + widgetBox.width / 2,
		widgetBox.y + widgetBox.height / 2
	);
	await page.mouse.down();
	await page.mouse.move(
		widgetBox.x + widgetBox.width / 2 + 96,
		widgetBox.y + widgetBox.height / 2 + 32,
		{ steps: 8 }
	);
	await expect(
		page.locator('[data-dashboard-interaction="drag"]')
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("dashboard-drag-feedback.png"),
	});
	await page.mouse.up();
	await expect(page.locator('[data-dashboard-interaction="idle"]')).toHaveCount(
		3
	);
	await expect(page.getByTestId("dashboard-save-status")).toHaveText(
		"Layout saved"
	);

	await page.reload();
	await page.setViewportSize({ width: 1280, height: 1200 });
	await expect(page.getByTestId("split-status")).toHaveText("One pane");

	const tab = page.getByTestId("drag-tab-a");
	const surface = page.getByTestId("split-demo-surface");
	await surface.scrollIntoViewIfNeeded();
	const tabBox = await tab.boundingBox();
	const surfaceBox = await surface.boundingBox();
	if (!(tabBox && surfaceBox)) {
		throw new Error("proof controls did not receive geometry");
	}

	await page.mouse.move(
		tabBox.x + tabBox.width / 2,
		tabBox.y + tabBox.height / 2
	);
	await page.mouse.down();
	await page.mouse.move(
		surfaceBox.x + surfaceBox.width * 0.82,
		surfaceBox.y + surfaceBox.height * 0.6,
		{ steps: 8 }
	);
	await expect(page.getByTestId("dnd-state")).toHaveText("Dragging Research");
	await expect(page.locator('[data-drop-preview="right"]')).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("split-drop-preview.png"),
	});
	await page.mouse.up();

	await expect(page.getByTestId("split-status")).toHaveText("Two panes");
	await expect(page.getByTestId("pane-tab-a")).toBeVisible();
	await expect(page.getByTestId("pane-tab-b")).toBeVisible();
	await expect(page.getByTestId("dnd-state")).toHaveText("Ready");
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("dashboard-tabs-motion-proof.png"),
	});

	await expect(page.locator("body")).not.toContainText("Application error");
	expect(consoleErrors).toEqual([]);
});
