import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

test("opens the General open-source license reader", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});

	await page.setViewportSize({ height: 900, width: 1440 });
	await page.goto("/open-source-licenses-proof.html");

	const licenseRow = page.getByTestId("open-source-licenses-row");
	await licenseRow.scrollIntoViewIfNeeded();
	await expect(licenseRow).toContainText(
		"Third-party notices for bundled dependencies"
	);
	await page.screenshot({
		path: testInfo.outputPath("open-source-licenses-row-proof.png"),
	});
	await licenseRow
		.getByRole("button", { name: "View open source licenses" })
		.click();

	const licenseDialog = page.locator('[data-slot="dialog-content"]');
	await expect(
		licenseDialog.getByRole("heading", {
			name: "Open source licenses",
			exact: true,
		})
	).toBeVisible();
	const licenseText = licenseDialog.locator("pre");
	await expect(licenseText).toContainText(
		"THE FOLLOWING SETS FORTH ATTRIBUTION NOTICES FOR THIRD PARTY SOFTWARE"
	);
	await expect(licenseText).toContainText("Permission is hereby granted");
	await expect(licenseText).toContainText("@office-kit/pptx (0.12.0)");
	await expect(licenseText).toContainText(/tauri \(/);

	await page.screenshot({
		path: testInfo.outputPath("open-source-licenses-proof.png"),
	});

	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});

test("keeps the license reader usable on a narrow window", async ({ page }) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});

	await page.setViewportSize({ height: 844, width: 390 });
	await page.goto("/open-source-licenses-proof.html");
	const licenseRow = page.getByTestId("open-source-licenses-row");
	await licenseRow.scrollIntoViewIfNeeded();
	await licenseRow
		.getByRole("button", { name: "View open source licenses" })
		.click();

	const licenseDialog = page.locator('[data-slot="dialog-content"]');
	await expect(licenseDialog).toBeVisible();
	await expect(licenseDialog.locator("pre")).toContainText(
		"THE FOLLOWING SETS FORTH ATTRIBUTION NOTICES"
	);
	await expect(licenseDialog).toHaveCSS("border-radius", "0px");
	await expect(
		licenseDialog.getByRole("heading", {
			name: "Open source licenses",
			exact: true,
		})
	).toBeVisible();

	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});
