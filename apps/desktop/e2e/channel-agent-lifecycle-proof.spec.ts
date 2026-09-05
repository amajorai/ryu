import { expect, test } from "@playwright/test";

const STORY_URL = "/channel-agent-lifecycle-proof.html";

test("proves channel fallback, setup toggles, and protected deletion", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => pageErrors.push(String(error)));

	await page.goto(STORY_URL);
	await page.waitForSelector("body[data-harness-ready='1']");

	await expect(page.getByRole("dialog", { name: "New agent" })).toBeVisible();
	const setupSwitches = page.getByRole("switch");
	await expect(setupSwitches).toHaveCount(3);
	await setupSwitches.nth(1).click();
	await setupSwitches.nth(2).click();
	await setupSwitches.nth(0).click();
	await expect(setupSwitches.nth(0)).toHaveAttribute("aria-checked", "false");
	await expect(setupSwitches.nth(1)).toHaveAttribute("aria-checked", "true");
	await expect(setupSwitches.nth(2)).toHaveAttribute("aria-checked", "true");

	await page.getByRole("dialog", { name: "New agent" }).press("Escape");
	await expect(page.getByRole("alert")).toContainText(
		"reverted to the default agent"
	);
	await expect(
		page.getByText(/Discord does not expose a public API/)
	).toBeVisible();

	await page.getByRole("button", { name: "Show protected delete" }).click();
	await expect(
		page.getByRole("alertdialog", { name: "Delete this channel?" })
	).toBeVisible();
	const slider = page.getByRole("slider", {
		name: "Delete Support Discord bot",
	});
	await expect(slider).toHaveAttribute("aria-valuenow", "0");
	for (let step = 0; step < 5; step += 1) {
		await slider.press("ArrowRight");
	}
	await expect(
		page.getByRole("alertdialog", { name: "Delete this channel?" })
	).toBeHidden();

	const unexpectedConsoleErrors = consoleErrors.filter(
		(message) =>
			!(
				message.includes("127.0.0.1:7980/api/") ||
				message.includes("Failed to load resource: net::ERR_FAILED") ||
				message.includes("Failed to load resource: net::ERR_CONNECTION_REFUSED")
			)
	);
	expect(unexpectedConsoleErrors).toEqual([]);
	expect(pageErrors).toEqual([]);
});
