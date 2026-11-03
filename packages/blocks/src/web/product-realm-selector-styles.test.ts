import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(
	new URL("./product-realm-selector.module.css", import.meta.url),
	"utf8"
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Declarations of the first top-level rule whose selector is exactly `selector`. */
function declarations(selector: string): Map<string, string> {
	const start = CSS.indexOf(`${selector} {`);
	if (start < 0) {
		return new Map();
	}
	const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("}", start));
	const entries = body
		.split(";")
		.map((declaration) => declaration.split(":").map((part) => part.trim()))
		.filter(([name, value]) => name && value)
		.map(([name, value]) => [name ?? "", value ?? ""] as const);
	return new Map(entries);
}

const CARD_FIGURE = '.figure [data-product-figure] [class~="iso-svg"]';

/** [ids, classes/attributes/pseudo-classes, types] of a simple selector list item. */
function specificity(selector: string): [number, number, number] {
	const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
	const classes =
		selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)?.length ?? 0;
	const types = selector
		.replace(/\[[^\]]+\]/g, " ")
		.split(/[\s>+~]+/)
		.filter((part) => /^[a-z]/i.test(part)).length;
	return [ids, classes, types];
}

function outranks(a: number[], b: number[]): boolean {
	for (let index = 0; index < a.length; index += 1) {
		if ((a[index] ?? 0) !== (b[index] ?? 0)) {
			return (a[index] ?? 0) > (b[index] ?? 0);
		}
	}
	return false;
}

describe("landing product card figures", () => {
	// Regression: a product page's hoisted bare-figure style stays in the head
	// after client navigation. At equal specificity it overrode the card's
	// height cap on the way back to the landing page, so the Desktop and Cloud
	// drawings overflowed and were clipped top and bottom.
	it("caps the figure height above the product pages' bare-figure style", () => {
		const source = readFileSync(
			new URL("./product-figure.tsx", import.meta.url),
			"utf8"
		);
		const bare = source.match(
			/"(\[data-product-figure\] \.iso-svg)\{[^}]*max-height/
		);
		expect(bare?.[1]).toBeDefined();
		expect(declarations(CARD_FIGURE).get("max-height")).toBe("13rem");
		expect(
			outranks(specificity(CARD_FIGURE), specificity(bare?.[1] ?? ""))
		).toBe(true);
	});

	// Regression: the card figure shrinks to its height cap (`width: auto`), so
	// without auto inline margins the Desktop, Core and Cloud drawings sat
	// flush left in their wide cards instead of centred.
	it("centres the height-capped figure horizontally in its card", () => {
		const rule = declarations(CARD_FIGURE);
		expect(rule.get("width")).toBe("auto");
		expect(rule.get("margin-inline")).toBe("auto");
	});
});
