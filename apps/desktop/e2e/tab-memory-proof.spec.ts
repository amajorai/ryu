import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

test("unloads restored inactive thread views while keeping the active route live", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => pageErrors.push(error.message));
	// The full Chromium build requests /favicon.ico, which the harness does not
	// serve; answer it so that request is not a console error.
	await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));

	await page.goto("/tab-memory-proof.html");
	await expect(page.getByTestId("memory-state")).toHaveText(
		"0 unloaded · 3 mounted"
	);
	await expect(page.locator("[data-proof-route]")).toHaveCount(3);

	await page.getByTestId("advance-clock").click();
	await expect(page.getByTestId("memory-state")).toHaveText(
		"2 unloaded · 1 mounted"
	);
	await expect(page.locator("[data-proof-route]")).toHaveCount(1);
	await expect(
		page.getByText("This tab is unloaded to save memory.")
	).toHaveCount(2);
	await expect(page.getByText("Mounted and live")).toHaveCount(1);

	expect(consoleErrors).toEqual([]);
	expect(pageErrors).toEqual([]);
});
