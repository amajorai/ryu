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
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("option", { name: "OS", exact: true })
	).not.toBeVisible();

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

for (const failure of [
	"write-refused",
	"write-discarded",
	"read-refused",
] as const) {
	test(`actual GeneralTab retains the requested realm after ${failure} and confirms an explicit retry across remount`, async ({
		page,
	}, testInfo) => {
		await page.addInitScript(() => {
			const originalGet = Storage.prototype.getItem;
			const originalSet = Storage.prototype.setItem;
			if (originalGet.call(localStorage, "ryu:startup-realm") === null) {
				originalSet.call(localStorage, "ryu:startup-realm", "bot");
			}
			Storage.prototype.setItem = function (key, value) {
				if (key === "ryu:startup-realm") {
					const failure =
						document.documentElement.dataset.startupStorageFailure;
					if (failure === "write-refused") {
						throw new DOMException(
							"Storage write refused",
							"QuotaExceededError"
						);
					}
					if (failure === "write-discarded") {
						return;
					}
				}
				originalSet.call(this, key, value);
			};
			Storage.prototype.getItem = function (key) {
				if (
					key === "ryu:startup-realm" &&
					document.documentElement.dataset.startupStorageFailure ===
						"read-refused"
				) {
					throw new DOMException("Storage read refused", "SecurityError");
				}
				return originalGet.call(this, key);
			};
		});
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ height: 1000, width: 1440 });
		await page.goto("/startup-realm-settings-proof.html");
		const realmSelect = page.locator("#startup-realm-select");
		const value = realmSelect.locator('[data-slot="select-value"]');
		await expect(value).toHaveText("Bot");
		await page.evaluate((failure) => {
			document.documentElement.dataset.startupStorageFailure = failure;
		}, failure);
		await realmSelect.click();
		await page.getByRole("option", { name: "OS", exact: true }).click();
		await expect(value).toHaveText("OS");
		const error = page
			.getByRole("alert")
			.filter({ hasText: "Startup realm could not" });
		await expect(error).toBeVisible();
		const retry = page.getByRole("button", {
			name: "Retry saving startup realm",
			exact: true,
		});
		await expect(retry).toBeEnabled();
		await expect(
			page.getByTestId("product-mode-lockup").getByText("Bot", { exact: true })
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("option", { name: "OS", exact: true })
		).toBeHidden();
		await page.screenshot({
			fullPage: true,
			path: testInfo.outputPath(`startup-realm-${failure}-pending.png`),
		});
		await page.evaluate(() => {
			delete document.documentElement.dataset.startupStorageFailure;
		});
		// Restoring permission alone does not silently save the retained draft.
		await expect(error).toBeVisible();
		expect(
			await page.evaluate(() => localStorage.getItem("ryu:startup-realm"))
		).toBe(failure === "read-refused" ? "os" : "bot");
		await retry.click();
		await expect(error).toHaveCount(0);
		await expect(retry).toHaveCount(0);
		expect(
			await page.evaluate(() => localStorage.getItem("ryu:startup-realm"))
		).toBe("os");
		await page.reload();
		await expect(
			page.locator('#startup-realm-select [data-slot="select-value"]')
		).toHaveText("OS");
		await expect(
			page.getByTestId("product-mode-lockup").getByText("OS", { exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: "Retry saving startup realm",
				exact: true,
			})
		).toHaveCount(0);
		await page.screenshot({
			fullPage: true,
			path: testInfo.outputPath(
				`startup-realm-${failure}-retry-completed-remount.png`
			),
		});
		expect(errors).toEqual([]);
	});
}
