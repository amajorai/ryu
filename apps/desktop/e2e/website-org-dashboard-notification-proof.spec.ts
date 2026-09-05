import { expect, test } from "@playwright/test";

const STORY_URL = "/website-org-dashboard-notification-proof.html";

test("proves the org dashboard Inbox bell rolls its unread count", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const inbox = page.getByTestId("inbox-nav-link");
	await expect(page.getByTestId("org-dashboard")).toBeVisible();
	await expect(inbox).toHaveAttribute("href", "/inbox");
	await expect(inbox).toHaveAttribute("aria-label", "Inbox, 4 unread");
	await expect(inbox.getByRole("status")).toHaveText("Notifications, 4 unread");

	await page.getByRole("button", { name: "Simulate new notification" }).click();
	await expect(inbox).toHaveAttribute("aria-label", "Inbox, 5 unread");
	await expect(inbox.getByRole("status")).toHaveText("Notifications, 5 unread");
	await expect(inbox.locator("svg")).toBeVisible();
	await page.waitForTimeout(700);

	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path:
			process.env.RYU_WEB_PROOF_SCREENSHOT ??
			"/private/tmp/ryu-website-org-dashboard-notification-proof.png",
	});
});
