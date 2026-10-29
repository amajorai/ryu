import path from "node:path";
import { expect, test } from "@playwright/test";

test("closed node menu does not fetch details and closing cancels pending details", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/node-selector-status-story.html?hold=1");
	const trigger = page.getByRole("button", { name: /Your computer/i });
	await expect(trigger).toBeVisible();
	await expect(trigger.locator('[data-slot="node-status-dot"]')).toHaveClass(
		/bg-success/
	);
	await page.waitForTimeout(100);
	expect(await page.evaluate(() => window.nodeMenuProof)).toEqual({
		info: 0,
		gateway: 0,
		cancelled: 0,
	});
	await trigger.click();
	await expect
		.poll(() => page.evaluate(() => window.nodeMenuProof.info))
		.toBe(1);
	await expect
		.poll(() => page.evaluate(() => window.nodeMenuProof.gateway))
		.toBe(1);
	await page.keyboard.press("Escape");
	await expect
		.poll(() => page.evaluate(() => window.nodeMenuProof.cancelled))
		.toBe(2);
	await page.goto("/node-selector-status-story.html");
	await expect(trigger).toBeVisible();
	await trigger.click();
	await expect(
		page.getByRole("menuitem", { name: /^Your computer/ })
	).toBeVisible();
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/performance-sweep/node-menu-completed.png"
		),
		fullPage: true,
	});
});
