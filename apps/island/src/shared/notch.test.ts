import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { NOTCH_PREF_KEY, notchWindowRect, parseNotchMode } from "./notch.ts";

describe("notch mode", () => {
	it("defaults off and rejects malformed values", () => {
		for (const value of [null, "", "false", "TRUE", "1", "{}", "null"]) {
			expect(parseNotchMode(value)).toBe(false);
		}
		expect(parseNotchMode("true")).toBe(true);
	});
	it("keeps compact and expanded content centered at the physical screen edge", () => {
		const notch = { displayId: 1, x: -950, y: -900, width: 200, height: 32 };
		for (const [width, height] of [
			[280, 68],
			[600, 432],
		]) {
			const rect = notchWindowRect(notch, width, height);
			expect(rect.x + rect.width / 2).toBe(notch.x + notch.width / 2);
			expect(rect.y).toBe(-900);
			expect(rect.height).toBe(height);
		}
	});
	it("uses the same preference key in Desktop and companion", () => {
		const source = readFileSync(
			new URL("../../../desktop/src/lib/api/preferences.ts", import.meta.url),
			"utf8"
		);
		expect(source).toContain(`ISLAND_NOTCH_PREF_KEY = "${NOTCH_PREF_KEY}"`);
	});
});
