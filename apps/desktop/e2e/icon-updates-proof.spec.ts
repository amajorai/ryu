import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 180_000 });

test("renders the flat handset and toggles the pinned summary", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/icon-updates-proof.html");
	await expect(page.getByTestId("call-ended-message-icon")).toBeVisible();
	await expect(
		page.getByText("Call ended · 01:24", { exact: true })
	).toBeVisible();
	await expect
		.poll(() =>
			page
				.getByText("Call ended · 01:24", { exact: true })
				.evaluate((element) => element.scrollWidth <= element.clientWidth)
		)
		.toBe(true);
	const toggle = page.getByRole("button", {
		name: "Hide pinned summary",
		exact: true,
	});
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await toggle.click();
	await expect(
		page.getByRole("complementary", { name: "Pinned summary" })
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Show pinned summary", exact: true })
		.click();
	await expect(
		page.getByRole("complementary", { name: "Pinned summary" })
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("chat-icons.png"),
		fullPage: true,
	});
	expect(errors).toEqual([]);
});
