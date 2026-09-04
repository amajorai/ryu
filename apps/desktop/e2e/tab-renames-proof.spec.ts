import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

test("double-click opens and commits the inline rename editors", async ({
	page,
}, testInfo) => {
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => pageErrors.push(error.message));

	await page.goto("/tab-renames-proof.html");
	await expect(page).toHaveTitle("Inline renames proof");
	await expect(page.getByTestId("group-name")).toHaveText("Research");

	await page.getByTestId("tab-group-header").dblclick();
	const groupInput = page.getByRole("textbox").first();
	await expect(groupInput).toHaveValue("Research");
	await groupInput.fill("Client research");
	await groupInput.press("Enter");
	await expect(page.getByTestId("group-name")).toHaveText("Client research");

	const presetTitle = page.getByText("Editorial layout", { exact: true });
	await presetTitle.dblclick();
	const presetInput = page.getByRole("textbox", {
		name: "New name for Editorial layout",
	});
	await expect(presetInput).toHaveValue("Editorial layout");
	await presetInput.fill("Review layout");
	await presetInput.press("Enter");
	await expect(page.getByText("Review layout", { exact: true })).toBeVisible();
	await page.mouse.move(10, 10);
	await page.waitForTimeout(200);
	await page.screenshot({
		path: testInfo.outputPath("inline-renames-proof.png"),
	});

	expect(consoleErrors).toEqual([]);
	expect(pageErrors).toEqual([]);
});
