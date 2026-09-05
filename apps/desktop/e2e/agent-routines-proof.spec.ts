import { expect, test } from "@playwright/test";

test("agent routines show health, durable destinations, and safe controls", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => consoleErrors.push(String(error)));

	await page.goto("/agent-routines-proof.html");
	await expect(page.getByTestId("agent-routines-overview")).toContainText(
		"Routine health"
	);
	await expect(page.getByTestId("agent-routine-row")).toHaveCount(3);
	await expect(
		page.getByText("cron: 0 9 * * 1-5 · Persistent chat", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Every 2h · New chat each run", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Run history" })
	).toBeVisible();
	await expect(page.getByTestId("agent-run-overview")).toContainText(
		"2 completed"
	);

	await page.getByRole("button", { name: "Add routine", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Add routine" });
	await dialog
		.getByRole("combobox", { name: "Transcript destination" })
		.selectOption("existing");
	await expect(
		dialog.getByRole("combobox", { name: "Persistent chat" })
	).toBeVisible();
	await expect(
		dialog.getByText("Every firing appends to the selected chat")
	).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

	await page
		.getByRole("button", { name: "Delete Weekly planning review" })
		.click();
	await expect(
		page.getByRole("alertdialog", { name: "Delete this routine?" })
	).toBeVisible();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Cancel" })
		.click();
	await expect(page.getByTestId("agent-routine-row")).toHaveCount(3);

	await page.screenshot({
		path: test.info().outputPath("agent-routines-proof.png"),
		fullPage: true,
	});
	expect(consoleErrors).toEqual([]);
});
