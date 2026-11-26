import { expect, test } from "@playwright/test";

const TRAILER = "Co-authored-by: Ryu <amajorhq@gmail.com>";

test("commit credit is on by default, saves each choice and survives a reload", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	await page.goto("/git-credit-proof.html", {
		waitUntil: "domcontentloaded",
	});

	const credit = page.getByRole("switch", {
		name: "Credit Ryu in git commits",
	});
	await expect(
		page.getByRole("heading", { name: "Commit credit" })
	).toBeVisible();
	// A node that never saved the preference credits Ryu.
	await expect(credit).toBeEnabled();
	await expect(credit).toHaveAttribute("aria-checked", "true");
	await expect(page.getByText(TRAILER)).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("git-credit-on-dark-desktop.png"),
	});

	await credit.click();
	await expect(credit).toHaveAttribute("aria-checked", "false");
	await page.reload();
	await expect(credit).toHaveAttribute("aria-checked", "false");
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("git-credit-off-dark-desktop.png"),
	});

	await credit.click();
	await expect(credit).toHaveAttribute("aria-checked", "true");
	await page.reload();
	await expect(credit).toHaveAttribute("aria-checked", "true");
	const writes: string[] = await page.evaluate(() =>
		JSON.parse(sessionStorage.getItem("proof-git-credit-ryu-writes") ?? "[]")
	);
	expect(writes).toEqual(["false", "true"]);

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(credit).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth
		)
	).toBe(true);
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("git-credit-on-dark-mobile.png"),
	});

	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto("/git-credit-proof.html?theme=light", {
		waitUntil: "domcontentloaded",
	});
	await expect(credit).toHaveAttribute("aria-checked", "true");
	await expect(page.getByText(TRAILER)).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("git-credit-on-light-desktop.png"),
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(credit).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth
		)
	).toBe(true);
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("git-credit-on-light-mobile.png"),
	});
	expect(errors).toEqual([]);
});
