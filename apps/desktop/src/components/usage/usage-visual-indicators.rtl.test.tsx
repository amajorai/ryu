import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stylesheet = readFileSync(
	new URL("./usage-visual-indicators.module.css", import.meta.url),
	"utf8"
);

function ruleBody(selector: string): string {
	const start = stylesheet.indexOf(`${selector} {`);
	if (start < 0) {
		throw new Error(`missing rule ${selector}`);
	}
	const end = stylesheet.indexOf("}", start);
	return stylesheet.slice(start, end);
}

describe("usage projected-use stripe under RTL", () => {
	test("anchors the stripe on the logical inline start so it mirrors with the fill", () => {
		const body = ruleBody(".projectedConsumption");
		expect(body).toMatch(/inset-inline-start:\s*var\(--usage-projected-left\)/);
		// A physical left/right offset would pin the stripe to the LTR end in Arabic.
		expect(body).not.toMatch(/(^|[\s;])(left|right)\s*:/m);
	});
});
