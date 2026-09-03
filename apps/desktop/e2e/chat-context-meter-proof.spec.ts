import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

test("renders semantic warning and critical context colors", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));

	await page.goto("/chat-context-meter-proof.html");

	const warning = page.getByTestId("warning-meter");
	const critical = page.getByTestId("critical-meter");
	const warningTrigger = warning.getByRole("button", {
		name: /Context 73% used/,
	});
	const criticalTrigger = critical.getByRole("button", {
		name: /Context 90% used/,
	});

	await expect(warningTrigger).toHaveClass(/text-warning/);
	await expect(warningTrigger).not.toHaveClass(/text-amber-500/);
	await expect(warningTrigger.locator("svg")).toHaveClass(/text-warning/);
	await expect(criticalTrigger).toHaveClass(/text-destructive/);
	await expect(criticalTrigger).not.toHaveClass(/text-amber-500/);
	await expect(criticalTrigger.locator("svg")).toHaveClass(/text-destructive/);

	const lightWarningColor = await warningTrigger.evaluate(
		(element) => getComputedStyle(element).color
	);
	await warningTrigger.click();
	await expect(warning.getByTestId("warning-context-opened")).toHaveText(
		"Context breakdown opened"
	);

	await page.getByTestId("theme-toggle").click();
	await expect(page.locator("html")).toHaveClass(/dark/);
	const darkWarningColor = await warningTrigger.evaluate(
		(element) => getComputedStyle(element).color
	);
	expect(darkWarningColor).not.toBe(lightWarningColor);

	await expect(warningTrigger).toHaveClass(/text-warning/);
	await expect(criticalTrigger).toHaveClass(/text-destructive/);
	await expect(page.locator(".text-amber-500")).toHaveCount(0);
	expect(browserErrors).toEqual([]);

	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("chat-context-meter-proof.png"),
	});
});
