import { describe, expect, it } from "bun:test";
import { parseKeybindingOverrides } from "./keybindings.ts";

describe("parseKeybindingOverrides", () => {
	it("keeps valid overrides and cleared bindings beside malformed entries", () => {
		expect(
			parseKeybindingOverrides(
				JSON.stringify({ next: "Alt+Tab", previous: null, malformed: 42 })
			)
		).toEqual({ next: "Alt+Tab", previous: null });
	});
	it("falls back for corrupt or non-object preferences", () => {
		for (const raw of [null, "", "{", "null", "[]", "42"]) {
			expect(parseKeybindingOverrides(raw)).toEqual({});
		}
	});
});
