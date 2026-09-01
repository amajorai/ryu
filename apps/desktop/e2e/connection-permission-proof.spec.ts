import { expect, test } from "@playwright/test";

test("reviews MCP and Composio access levels with a risk-based default", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => consoleErrors.push(String(error)));

	await page.goto("/connection-permission-proof.html");
	await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "1");
	await expect(
		page.getByRole("heading", {
			name: "Connected accounts stay on a clear access ceiling",
		})
	).toBeVisible();

	await page.getByRole("button", { name: "Review Composio access" }).click();
	const dialog = page.getByTestId("connection-permission-dialog");
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByRole("radio", { name: /Risk-based \(recommended\)/ })
	).toBeVisible();
	await expect(dialog.getByRole("radio", { name: /^Read only/ })).toBeVisible();
	await expect(
		dialog.getByRole("radio", { name: /^Write access/ })
	).toBeVisible();
	await expect(
		dialog.getByRole("radio", { name: /^Full access, including delete/ })
	).toBeVisible();
	await expect(
		dialog.getByRole("radio", { name: "Risk-based (recommended)" })
	).toBeChecked();

	await dialog.getByRole("radio", { name: "Read only" }).check();
	await dialog.getByRole("button", { name: "Continue to connect" }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByText("Read only", { exact: true }).first()
	).toBeVisible();

	await page.getByRole("button", { name: "Review MCP access" }).click();
	await expect(dialog).toContainText(
		"Review access before connecting People MCP"
	);
	await dialog
		.getByRole("radio", { name: "Full access, including delete" })
		.check();
	await dialog.getByRole("button", { name: "Continue to connect" }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByText("Full access", { exact: true }).first()
	).toBeVisible();

	expect(consoleErrors).toEqual([]);
});
