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

describe("landing product card figures", () => {
	// Regression: the card figure shrinks to its height cap (`width: auto`), so
	// without auto inline margins the Desktop, Core and Cloud drawings sat
	// flush left in their wide cards instead of centred.
	it("centres the height-capped figure horizontally in its card", () => {
		const rule = declarations('.figure [class~="iso-svg"]');
		expect(rule.get("width")).toBe("auto");
		expect(rule.get("margin-inline")).toBe("auto");
	});
});
