import { expect, test } from "@playwright/test";

// The "Lifetime updates" row of the real AppUpdatesSettings, in Chromium,
// against the app-updates proof harness. The row only exists for a signed-in
// account with a recorded updates window, so the account vault and the
// account-scoped window record are seeded the way the entitlement resolve
// writes them at launch. A clamped update check must turn the plain notice
// into the expired-window notice, and the row's own Extend updates button
// must open Billing.

const STORY_URL = "/app-updates-settings-proof.html?scenario=cutoff";

declare global {
	interface Window {
		__appUpdateUnknownCommands: string[];
	}
}

test("a clamped check turns the lifetime-updates row into the expired notice, and its Extend updates button opens Billing", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(() => {
		const userId = "updates-window-user";
		localStorage.setItem(
			"ryu_accounts",
			JSON.stringify([
				{
					userId,
					email: "owner@example.test",
					image: null,
					name: "Owner",
					token: "local-fixture-token",
				},
			])
		);
		localStorage.setItem("ryu_active_user_id", userId);
		localStorage.setItem(
			"ryu.updates-window",
			JSON.stringify({
				accountId: userId,
				windowEndsAt: "2026-03-31T12:00:00.000Z",
			})
		);
	});
	await page.setViewportSize({ height: 900, width: 1280 });
	await page.goto(STORY_URL);
	await expect(page.getByTestId("app-updates-settings-proof")).toBeVisible();

	const row = page
		.getByText("Lifetime updates", { exact: true })
		.locator(
			"xpath=ancestor::*[contains(., 'Updates included through') or contains(., 'Your lifetime updates ended')][1]"
		);
	await expect(row).toContainText(/Updates included through .*2026\./u);
	// Nothing is withheld yet, so the row sells nothing.
	await expect(
		page.getByRole("button", { name: "Extend updates", exact: true })
	).toHaveCount(0);

	await page.getByRole("button", { name: "Check for updates" }).click();
	await expect(
		page.getByText("Ryu is up to date for your updates window", { exact: true })
	).toBeVisible();
	await expect(row).toContainText(
		/Your lifetime updates ended on .*2026\. Ryu stays on the newest build they cover\./u
	);
	await expect(row).not.toContainText("Updates included through");

	await page
		.getByRole("button", { name: "Extend updates", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Billing", exact: true })
	).toBeVisible();
	expect(errors).toEqual([]);
	expect(await page.evaluate(() => window.__appUpdateUnknownCommands)).toEqual(
		[]
	);
});
