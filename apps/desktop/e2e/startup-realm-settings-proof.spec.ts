import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

test("defaults to Bot and restores the saved startup realm", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto("/startup-realm-settings-proof.html");

	await expect(page.getByTestId("startup-realm-proof")).toBeVisible();
	const lockup = page.getByTestId("product-mode-lockup");
	await expect(lockup.getByText("Bot", { exact: true })).toBeVisible();

	const realmSelect = page.locator("#startup-realm-select");
	const realmValue = realmSelect.locator('[data-slot="select-value"]');
	await expect(realmValue).toHaveText("Last used");
	await realmSelect.click();
	await page.getByRole("option", { name: "OS", exact: true }).click();
	await expect(realmValue).toHaveText("OS");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:startup-realm"))
	).resolves.toBe("os");

	// The setting is for the next launch, so choosing OS does not mutate the
	// current workspace immediately.
	await expect(lockup.getByText("Bot", { exact: true })).toBeVisible();
	await page.reload();
	await expect(
		page.getByTestId("product-mode-lockup").getByText("OS", { exact: true })
	).toBeVisible();

	// Change the current realm to Bot, then switch the startup policy back to
	// Last used. The next reload should follow that saved last-used value.
	await page.getByTestId("product-mode-trigger").click();
	await page.getByRole("menuitemradio", { name: /Bot/ }).click();
	await expect(
		page.getByTestId("product-mode-lockup").getByText("Bot", { exact: true })
	).toBeVisible();

	const lastUsedSelect = page.locator("#startup-realm-select");
	const lastUsedValue = lastUsedSelect.locator('[data-slot="select-value"]');
	await lastUsedSelect.click();
	await page.getByRole("option", { name: "Last used", exact: true }).click();
	await expect(lastUsedValue).toHaveText("Last used");

	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("startup-realm-settings-proof.png"),
	});

	await page.reload();
	await expect(
		page.getByTestId("product-mode-lockup").getByText("Bot", { exact: true })
	).toBeVisible();
	await expect(
		browserErrors,
		`browser errors: ${browserErrors.join(" | ")}`
	).toEqual([]);
});
