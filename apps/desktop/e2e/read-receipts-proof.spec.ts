import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

test("renders sent and seen states, then opens the full reader roster", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/read-receipts-proof.html");

	await expect(page.getByTestId("read-receipts-proof")).toBeVisible();
	const receipts = page.locator('[data-slot="message-read-receipt"]');
	await expect(receipts).toHaveCount(3);
	await expect(page.locator('[data-read-state="sent"]')).toHaveCount(1);
	await expect(page.locator('[data-read-state="read"]')).toHaveCount(2);
	await expect(
		page.getByRole("button", { name: "Seen by Alex Chen" }).first()
	).toBeVisible();

	// The receipt shows on hover of its message (a quiet transcript). Point at
	// the bubble, then glide down to the receipt the way a pointer does: every
	// step on the way must keep the receipt revealed and clickable.
	const receipt = page
		.getByRole("button", { name: "Seen by Alex Chen" })
		.first();
	const bubble = page
		.locator('[data-slot="message-scroller-item"]')
		.filter({ has: receipt })
		.first()
		.getByTestId("user-message-bubble");
	await bubble.hover();
	const target = await receipt.boundingBox();
	expect(target).not.toBeNull();
	if (target) {
		await page.mouse.move(
			target.x + target.width / 2,
			target.y + target.height / 2,
			{ steps: 12 }
		);
	}
	await receipt.click();
	await expect(page.getByText("Seen by", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Alex Chen", { exact: true }).last()
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: "../../docs/proof/read-receipts/read-receipts-completed.png",
	});
	await expect(errors).toEqual([]);
});
