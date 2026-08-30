import { expect, test } from "@playwright/test";

test("renders the billing lifecycle and account-aware invitation proof", async ({
	page,
}) => {
	await page.goto("/billing-transactional-emails-proof.html");

	await expect(page.getByTestId("proof-status")).toHaveText("VERIFIED");
	await expect(page.getByTestId("organization-notification-count")).toHaveText(
		"9 of 9 enabled"
	);
	await expect(
		page.getByTestId("org-notification-toggle-payment-past-due")
	).toHaveAttribute("aria-pressed", "true");
	await page.getByTestId("org-notification-toggle-payment-past-due").click();
	await expect(page.getByTestId("organization-notification-count")).toHaveText(
		"8 of 9 enabled"
	);
	await expect(
		page.getByTestId("org-notification-toggle-payment-past-due")
	).toHaveAttribute("aria-pressed", "false");
	await expect(
		page.getByTestId("transactional-email-grid").locator("[data-email-card]")
	).toHaveCount(9);
	await expect(page.getByText("Your Ryu subscription renewed")).toBeVisible();
	await expect(
		page.getByText("A quick fix for your Ryu payment")
	).toBeVisible();
	await expect(
		page.getByText("Your Ryu subscription needs attention")
	).toBeVisible();
	await expect(
		page.getByText("Organization activity", { exact: true }).first()
	).toBeVisible();
	await expect(page.getByText("Join Acme on Ryu")).toBeVisible();

	await page.getByRole("button", { name: "New Ryu account" }).click();
	await expect(page.getByText("You’ve been invited to Acme")).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Create your Ryu account" })
	).toHaveAttribute(
		"href",
		/\/login\?view=signup&callback=%2Forganizations%2Faccept-invitation%2Finv_123/
	);

	await page.getByRole("button", { name: "Existing Ryu account" }).click();
	await expect(page.getByText("Join Acme on Ryu")).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Accept the invitation" })
	).toHaveAttribute(
		"href",
		"https://app.ryuhq.com/organizations/accept-invitation/inv_123"
	);
});

test("renders the replay suppression proof", async ({ page }) => {
	await page.goto("/billing-transactional-emails-proof.html");
	await page.getByTestId("replay-button").click();
	await expect(page.getByTestId("replay-proof")).toHaveText(
		"Replay proof complete"
	);
	await expect(
		page.getByText("1 sent · 1 replay suppressed by dedupe key")
	).toBeVisible();
});
