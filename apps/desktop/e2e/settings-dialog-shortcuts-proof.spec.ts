import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

const STORY_URL = "/settings-dialog-shortcuts-proof.html";

test("opens both dialogs from platform-aware shortcuts and hides them on mobile", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("requestfailed", (request) => {
		browserErrors.push(
			`${request.url()} ${request.failure()?.errorText ?? "request failed"}`
		);
	});
	await page.route("http://localhost:3000/api/auth/get-session", (route) =>
		route.fulfill({
			body: JSON.stringify({ session: null, user: null }),
			contentType: "application/json",
			status: 200,
		})
	);
	await page.goto(STORY_URL);
	await expect(page.locator("body")).toHaveAttribute(
		"data-hotkeys-ready",
		"true"
	);

	await page.keyboard.down("Control");
	await page.keyboard.press(".");
	await page.keyboard.up("Control");
	await expect(page.getByTestId("shortcut-last-action")).toHaveText(
		"settings.open"
	);
	const settingsDialog = page.locator('[data-slot="dialog-content"]');
	await expect(settingsDialog).toBeVisible();
	await expect(
		settingsDialog.getByRole("heading", { name: "General", exact: true })
	).toBeVisible();
	const generalButton = settingsDialog.getByRole("button", {
		name: "General",
		exact: true,
	});
	const iconTile = generalButton.locator(':scope > span[aria-hidden="true"]');
	const iconPadding = await iconTile.evaluate((tile) => {
		const icon = tile.querySelector("svg");
		if (!icon) {
			return 0;
		}
		const tileRect = tile.getBoundingClientRect();
		const iconRect = icon.getBoundingClientRect();
		return Math.min(
			iconRect.left - tileRect.left,
			tileRect.right - iconRect.right,
			iconRect.top - tileRect.top,
			tileRect.bottom - iconRect.bottom
		);
	});
	// Allow fractional layout rounding around the intended 4 px gutter.
	expect(iconPadding).toBeGreaterThanOrEqual(3.9);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("settings-dialog-sidebar-icon-padding.png"),
	});
	await settingsDialog.getByText("Keyboard Shortcuts", { exact: true }).click();
	await expect(
		settingsDialog.getByText("Open Settings", { exact: true })
	).toBeVisible();
	await expect(
		settingsDialog.getByText("Open Gateway Settings", { exact: true })
	).toBeVisible();

	for (const section of [
		"Appearance",
		"Keyboard Shortcuts",
		"Voice",
		"Account",
		"Sessions & devices",
		"Ryu apps",
		"OAuth apps",
		"Billing",
		"Referrals",
		"Teams",
		"Credits",
		"Usage",
		"Updates",
		"Developer",
		"Settings Sync",
	]) {
		const navigation = settingsDialog.getByRole("button", {
			name: section,
			exact: true,
		});
		await expect(navigation).toBeVisible();
		await navigation.click();
		if (!(await settingsDialog.isVisible())) {
			throw new Error(
				`Settings dialog closed after selecting ${section}; browser errors: ${browserErrors.join(" | ")}`
			);
		}
		await expect(settingsDialog).toBeVisible();
		await expect(settingsDialog.locator("h2")).toHaveText(section);
	}

	await page.keyboard.press("Escape");
	await expect(settingsDialog).not.toBeVisible();

	await page.keyboard.down("Control");
	await page.keyboard.press(",");
	await page.keyboard.up("Control");
	await expect(page.getByTestId("shortcut-last-action")).toHaveText(
		"gateway.open"
	);
	const gatewayDialog = page.locator('[data-slot="dialog-content"]');
	await expect(gatewayDialog).toBeVisible();
	await expect(
		gatewayDialog.getByRole("heading", { name: "Overview", exact: true })
	).toBeVisible();

	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("settings-dialog-shortcuts-proof.png"),
	});

	await page.keyboard.press("Escape");
	await page.getByTestId("switch-mobile").click();
	await page.getByTestId("open-mobile-keyboard").click();
	await expect(page.getByTestId("proof-surface")).toHaveText("mobile");
	await expect(
		page.getByRole("heading", { name: "General", exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Keyboard Shortcuts", { exact: true })
	).not.toBeVisible();
	await expect(
		page.getByRole("button", { name: "Open Keyboard Shortcuts" })
	).not.toBeVisible();

	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});
