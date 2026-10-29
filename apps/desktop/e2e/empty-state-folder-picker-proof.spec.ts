import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const STORY_URL = "/empty-state-folder-picker-proof.html";
const PROOF_SCREENSHOT = resolve(
	import.meta.dirname,
	"../../../docs/proof/empty-state-folder-picker-dotted-hover.png"
);
const PROOF_LOG = resolve(
	import.meta.dirname,
	"../../../docs/proof/empty-state-folder-picker-dotted-hover.log.json"
);

test.setTimeout(120_000);

test("empty chat folder picker uses dotted text-only hover treatment", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1200, height: 800 });
	await page.goto(STORY_URL);
	await page.waitForLoadState("networkidle");

	await expect(
		page.getByRole("heading", { name: "What are we doing in", exact: true })
	).toBeVisible();
	const trigger = page.getByRole("button", {
		name: "Select project folder",
	});
	await expect(trigger).toHaveText("ryu");
	await expect(trigger).toHaveAttribute("data-open", "false");

	const mutedColor = await page
		.getByTestId("muted-foreground-reference")
		.evaluate((element) => getComputedStyle(element).color);
	const rest = await trigger.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			background: style.backgroundColor,
			color: style.color,
			decorationLine: style.textDecorationLine,
			decorationStyle: style.textDecorationStyle,
		};
	});

	expect(rest.background).toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/);
	expect(rest.color).not.toBe(mutedColor);
	expect(rest.decorationLine).toContain("underline");
	expect(rest.decorationStyle).toBe("dotted");

	await trigger.hover();
	await expect
		.poll(() =>
			trigger.evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					background: style.backgroundColor,
					color: style.color,
				};
			})
		)
		.toEqual({ background: rest.background, color: mutedColor });

	const hover = await trigger.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			background: style.backgroundColor,
			color: style.color,
		};
	});
	mkdirSync(dirname(PROOF_SCREENSHOT), { recursive: true });
	await page.screenshot({ path: PROOF_SCREENSHOT });
	writeFileSync(
		PROOF_LOG,
		`${JSON.stringify({ mutedColor, rest, hover }, null, 2)}\n`
	);
});
