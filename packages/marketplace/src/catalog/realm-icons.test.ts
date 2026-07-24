// The realm→glyph map is the single source of truth shared by the tab nav and
// the card fallback, so they can never drift. Pin that every realm has a glyph
// and the glyphs are distinct (the drift this map exists to prevent — skills
// wearing the plugins puzzle, workflows using a mismatched variant).

import { describe, expect, test } from "bun:test";
import { type CatalogRealm, REALM_ICONS } from "./realm-icons.ts";

const REALMS: CatalogRealm[] = [
	"apps",
	"plugins",
	"models",
	"skills",
	"mcp",
	"agents",
	"workflows",
];

describe("REALM_ICONS", () => {
	test("every realm maps to a defined glyph", () => {
		for (const realm of REALMS) {
			expect(REALM_ICONS[realm]).toBeDefined();
		}
	});

	test("the map has exactly the known realms, no extras", () => {
		expect(Object.keys(REALM_ICONS).sort()).toEqual([...REALMS].sort());
	});

	test("glyphs are distinct across realms (no accidental reuse)", () => {
		const glyphs = REALMS.map((r) => REALM_ICONS[r]);
		expect(new Set(glyphs).size).toBe(REALMS.length);
	});
});
