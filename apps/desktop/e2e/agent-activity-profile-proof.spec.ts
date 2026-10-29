import path from "node:path";
import { expect, test } from "@playwright/test";

test("agent profile shows only its own recent activity and opens the matching transcript", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.route("https://api.iconify.design/**", (route) =>
		route.fulfill({
			body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M4 6h16v14H4zM4 10h16M8 3v4m8-4v4"/></svg>',
			contentType: "image/svg+xml",
			status: 200,
		})
	);

	await page.goto("/agent-activity-profile-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByTestId("agent-activity-panel")).toHaveCount(0);
	await page
		.getByRole("button", { name: "Open Muse profile and activity" })
		.click();
	await expect(page.getByTestId("agent-activity-panel")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Muse" })).toBeVisible();
	await expect(page.getByLabel("Node status: Connected")).toBeVisible();
	await expect(
		page.getByTestId("agent-activity-panel").getByRole("tab")
	).toHaveCount(4);
	await expect(page.getByRole("tab", { name: "Calendar" })).toBeVisible();
	await expect(page.getByRole("tab", { name: "Routines" })).toHaveCount(0);
	await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(page.getByTestId("agent-activity-feed")).toContainText("Today");
	await expect(page.getByTestId("agent-activity-feed")).toContainText(
		"Plan Jackson Hole Trip"
	);
	await expect(page.getByTestId("agent-activity-feed")).toContainText(
		"Compared flight and lodging options for October dates."
	);
	await expect(page.getByTestId("agent-activity-feed")).toContainText(
		"Yesterday"
	);
	await expect(page.getByTestId("agent-activity-feed")).not.toContainText(
		"Other agent private work"
	);

	await page.screenshot({
		fullPage: true,
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/agent-activity-profile/agent-activity-profile-proof.png"
		),
	});

	await page.getByRole("tab", { name: "Identity" }).click();
	await expect(page.getByTestId("agent-identity-view")).toContainText(
		"Agent ID"
	);
	await expect(page.getByTestId("agent-identity-view")).toContainText(
		"agent-muse"
	);
	await page.getByRole("tab", { name: "Activity" }).click();
	await page
		.getByRole("button", { name: "Open Plan Jackson Hole Trip" })
		.click();
	await expect(page.getByTestId("active-conversation")).toHaveText(
		"chat-muse-today"
	);
	await expect(page.locator("body")).toHaveAttribute(
		"data-opened-conversation",
		"chat-muse-today"
	);
	await expect(page.locator("body")).toHaveAttribute(
		"data-opened-path",
		"/chat"
	);
	await expect.poll(() => browserErrors).toEqual([]);
});
