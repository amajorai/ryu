import { describe, expect, test } from "bun:test";

// `.ryu-color-scheme-light` pins a subtree (an embedded Ask Ryu widget set to
// light) to the light tokens on a `.dark` page and keeps `dark:` off inside it.

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("light color-scheme scope", () => {
	test("re-declares the light tokens on the scope class", async () => {
		const colors = await read("./globals/colors.css");
		expect(colors).toMatch(
			/:root,\s*\.ryu-color-scheme-light\s*\{\s*--card: oklch\(1 0 0\);/
		);
	});

	test("keeps the dark variant off inside a light-pinned subtree", async () => {
		const base = await read("./globals/base.css");
		expect(base).toContain(
			"@custom-variant dark (&:is(.dark *):not(.ryu-color-scheme-light *));"
		);
	});
});
