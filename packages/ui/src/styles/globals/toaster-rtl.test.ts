import { describe, expect, test } from "bun:test";

// Sileo's injected `[data-sileo-description] { text-align: left }` (specificity
// 0,1,0, added at runtime after our stylesheet) left right-to-left toast bodies
// flush-left. The shared override must out-rank it and align to the start edge.

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("toaster RTL alignment", () => {
	test("aligns toast descriptions to the start edge", async () => {
		const base = await read("./base.css");
		expect(base).toMatch(
			/\[data-slot="toaster"\] \[data-sileo-description\]\s*\{\s*text-align: start;\s*\}/
		);
	});

	test("does not wrap the override in :where(), which would tie the vendor rule", async () => {
		const base = await read("./base.css");
		expect(base).not.toMatch(
			/:where\(\[data-slot="toaster"\]\)\s*\[data-sileo-description\]/
		);
	});
});
