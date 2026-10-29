import { expect, test } from "@playwright/test";

const STORY_URL = "/office-workspace-proof.html";

test("edits Office files and opens WhatsApp in the same workspace tab strip", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(page.getByTestId("office-workspace-proof")).toBeVisible();
	for (const tab of ["pdf", "pptx", "xlsx", "docx", "whatsapp"]) {
		await expect(page.getByTestId(`workspace-tab-${tab}`)).toBeVisible();
	}

	const firstSlideText = page.locator("textarea").first();
	await expect(firstSlideText).toHaveValue("Quarterly product review");
	await firstSlideText.fill("Quarterly product review — edited in Ryu");
	await firstSlideText.blur();
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	const slidePreview = page.getByAltText("Slide 1 preview");
	await expect
		.poll(async () =>
			decodeURIComponent((await slidePreview.getAttribute("src")) ?? "")
		)
		.toContain("edited in Ryu");
	await slidePreview.evaluate((image) => image.decode());
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByText(/Saved \d+ KB to Space/u)).toBeVisible();
	await page.screenshot({
		path: test.info().outputPath("office-workspace-proof.png"),
	});

	await page.getByTestId("workspace-tab-xlsx").click();
	const revenueCell = page.getByRole("textbox", { exact: true, name: "B2" });
	await expect(revenueCell).toHaveValue("420000");
	await revenueCell.fill("450000");
	await revenueCell.blur();
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByText(/Saved \d+ KB to Space/u)).toBeVisible();

	await page.getByTestId("workspace-tab-whatsapp").click();
	const platform = page.getByLabel("Platform");
	await expect(platform).toHaveValue("whatsapp");
	await expect(platform.locator("option:checked")).toHaveText(
		"WhatsApp Business (Cloud API)"
	);
	await platform.selectOption("whatsapp_personal");
	await expect(platform.locator("option:checked")).toHaveText(
		"WhatsApp Personal"
	);
	await page.screenshot({
		path: test.info().outputPath("whatsapp-workspace-proof.png"),
	});
});
