import { expect, type Page, test } from "@playwright/test";

const TAILWIND_LAYER_ORDER = [
	"properties",
	"theme",
	"base",
	"components",
	"utilities",
];

let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
	pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("chat-artifact-layer-order-proof.html");
	await expect(page.getByText("const answer = 42;")).toBeVisible();
});

test.afterEach(() => {
	expect(pageErrors).toEqual([]);
});

/** Pixels for `n` steps of the theme spacing, resolved by the browser itself. */
async function spacing(page: Page) {
	const oracle = page.getByTestId("spacing-oracle");
	const values = await oracle.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			margin: Number.parseFloat(style.marginLeft),
			padding: Number.parseFloat(style.paddingLeft),
		};
	});
	expect(values.padding).toBeGreaterThan(0);
	expect(values.margin).toBeCloseTo(values.padding * 2, 3);
	return (steps: number) => values.padding * steps;
}

test("a chat stylesheet loaded before index.css keeps Tailwind's layer order and spacing", async ({
	page,
}) => {
	const cascade = await page.evaluate(() => {
		const order: string[] = [];
		const texts: string[] = [];
		const visit = (rules: CSSRuleList) => {
			for (const rule of Array.from(rules)) {
				texts.push(rule.cssText);
				if (rule instanceof CSSLayerStatementRule) {
					order.push(...rule.nameList);
				} else if (rule instanceof CSSLayerBlockRule) {
					order.push(rule.name);
					visit(rule.cssRules);
				} else if (rule instanceof CSSGroupingRule) {
					visit(rule.cssRules);
				}
			}
		};
		for (const sheet of Array.from(document.styleSheets)) {
			visit(sheet.cssRules);
		}
		return {
			moduleRule: texts.findIndex((text) => text.includes("codeText")),
			order: [...new Set(order)],
			tailwindStatement: texts.findIndex(
				(text) => text.startsWith("@layer theme") && !text.includes("{")
			),
		};
	});
	// Precondition: the harness build reproduces main.tsx's import order, where
	// the chat module stylesheet precedes the Tailwind entry's layer statement.
	expect(cascade.moduleRule).toBeGreaterThanOrEqual(0);
	expect(cascade.tailwindStatement).toBeGreaterThan(cascade.moduleRule);
	// Utilities must stay the highest-priority layer, above Preflight's reset.
	expect(cascade.order.slice(0, TAILWIND_LAYER_ORDER.length)).toEqual(
		TAILWIND_LAYER_ORDER
	);

	const step = await spacing(page);
	const control = await page
		.getByTestId("edge-control")
		.evaluate((element) => getComputedStyle(element).paddingLeft);
	const row = await page.getByTestId("dock-row").evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			marginLeft: style.marginLeft,
			marginRight: style.marginRight,
			paddingLeft: style.paddingLeft,
		};
	});
	expect(Number.parseFloat(control)).toBeCloseTo(step(1), 3);
	expect(Number.parseFloat(row.paddingLeft)).toBeCloseTo(step(2), 3);
	expect(Number.parseFloat(row.marginLeft)).toBeCloseTo(step(2), 3);
	expect(Number.parseFloat(row.marginRight)).toBeCloseTo(step(2), 3);
	// Margin plus padding keep the control clear of the viewport edge, where the
	// workspace dock's hover strip sits.
	const box = await page.getByTestId("edge-control").boundingBox();
	if (!box) {
		throw new Error("The edge control geometry was unavailable.");
	}
	expect(box.x).toBeCloseTo(step(4), 1);
});

test("the artifact code view keeps its padding and its code line-height override", async ({
	page,
}) => {
	const step = await spacing(page);
	const code = page.getByTestId("artifact").locator("pre");
	await expect(code).toHaveText("const answer = 42;");
	const style = await code.evaluate((element) => {
		const computed = getComputedStyle(element);
		return {
			fontSize: Number.parseFloat(computed.fontSize),
			lineHeight: Number.parseFloat(computed.lineHeight),
			paddingLeft: Number.parseFloat(computed.paddingLeft),
			paddingTop: Number.parseFloat(computed.paddingTop),
		};
	});
	expect(style.paddingTop).toBeCloseTo(step(3), 3);
	expect(style.paddingLeft).toBeCloseTo(step(3), 3);
	// `type-image-viewer-caption` sets 12.5px; `.codeText` sets 1.55 leading.
	expect(style.fontSize).toBeCloseTo(12.5, 3);
	expect(style.lineHeight).toBeCloseTo(12.5 * 1.55, 1);
});
