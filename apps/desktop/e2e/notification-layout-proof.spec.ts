import { expect, test } from "@playwright/test";

const STORY_URL = "/notification-layout-proof.html";

test("proves the appearance slider switches between split, grouped, and unified", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const slider = page.getByRole("slider", { name: "Notification layout" });
	await expect(page.getByTestId("notification-layout-value")).toHaveText(
		"Unified"
	);
	await expect(page.getByTestId("notification-surface")).toBeVisible();
	await expect(page.getByTestId("announcement-surface")).toHaveCount(0);

	await slider.press("Home");
	await expect(page.getByTestId("notification-layout-value")).toHaveText(
		"Split"
	);
	await expect(page.getByTestId("announcement-surface")).toBeVisible();
	await expect(page.getByTestId("inbox-surface")).toBeVisible();
	await expect(page.getByTestId("notification-surface")).toHaveCount(0);

	await slider.press("ArrowRight");
	await expect(page.getByTestId("notification-layout-value")).toHaveText(
		"Grouped"
	);
	await expect(page.getByTestId("notification-surface")).toBeVisible();
	await expect(page.getByTestId("announcement-surface")).toHaveCount(0);

	await slider.press("End");
	await expect(page.getByTestId("notification-layout-value")).toHaveText(
		"Unified"
	);
	await expect(page.getByTestId("mode-unified")).toHaveClass(/border-primary/);
});

test("proves the stack expands and keeps card actions clickable", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const slider = page.getByRole("slider", { name: "Notification layout" });
	await slider.press("End");
	const stack = page.getByTestId("notification-surface");
	const expand = stack.getByRole("button", {
		name: /notifications\. expand notifications/i,
	});
	await expand.click();
	await expect(stack.getByText("Appearance update").last()).toBeVisible();

	await stack
		.getByRole("button", { name: "Mark Appearance update read" })
		.click();
	await expect(page.getByTestId("proof-status")).toHaveText(
		"Marked Appearance update read"
	);
});

test("proves the sidebar inbox bell rings and rolls its count", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const bell = page.getByTestId("notification-bell");
	await expect(page.getByTestId("notification-bell-footer")).toBeVisible();
	await expect(bell).toBeVisible();
	await expect(bell.getByRole("status")).toHaveText("Notifications, 4 unread");

	await page.getByRole("button", { name: "Simulate new notification" }).click();
	await expect(bell.getByRole("status")).toHaveText("Notifications, 5 unread");
	await expect(bell.locator("svg")).toBeVisible();
	await page.waitForTimeout(700);

	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path:
			process.env.RYU_PROOF_SCREENSHOT ??
			"/private/tmp/ryu-notification-inbox-bell-proof.png",
	});

	await bell.click();
	await expect(page.getByTestId("notification-tray-panel")).toBeVisible();
	await expect(bell).toHaveAttribute("aria-expanded", "true");
	await page.waitForTimeout(500);

	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path:
			process.env.RYU_TRAY_PROOF_SCREENSHOT ??
			"/private/tmp/ryu-notification-inbox-tray-proof.png",
	});

	await page.keyboard.press("Escape");
	await expect(bell).toHaveAttribute("aria-expanded", "false");
	await expect(bell).toBeFocused();
});
