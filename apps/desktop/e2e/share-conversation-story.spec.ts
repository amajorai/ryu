import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

test("conversation sharing exposes the live and public access controls", async ({
	page,
}) => {
	await page.goto("/share-conversation-story.html");
	const dialog = page.getByTestId("share-conversation-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Launch readiness and rollout plan");
	await expect(dialog).toContainText("Jia Wei Ng (you)");
	await expect(dialog).toContainText("Noor Aziz");
	await expect(dialog.getByLabel("Role for Noor Aziz")).toContainText("Viewer");
	await expect(
		dialog.getByRole("combobox", { name: "General access" })
	).toContainText("Anyone with the link");
	await expect(dialog).toContainText("frozen copy");
	await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Update copy" })
	).toBeVisible();

	await dialog.getByRole("combobox", { name: "General access" }).click();
	await expect(page.getByRole("option", { name: "Restricted" })).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Anyone in the organization" })
	).toBeVisible();
	await expect(page.getByRole("option", { name: "A team" })).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Anyone with the link" })
	).toBeVisible();

	await page.getByRole("option", { name: "Anyone with the link" }).click();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByTestId("share-result")).toHaveText("published");
});

test("viewers can inspect access without changing it", async ({ page }) => {
	await page.goto("/share-conversation-story.html?readonly=1");
	const dialog = page.getByTestId("share-conversation-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Mira Chen");
	await expect(dialog.getByLabel("Add a person")).toBeDisabled();
	await expect(dialog.getByLabel("Role for Jia Wei Ng")).toBeDisabled();
	await expect(
		dialog.getByRole("combobox", { name: "General access" })
	).toBeDisabled();
	await expect(dialog).toContainText(
		"Only the owner or an organization admin can change access."
	);
});
