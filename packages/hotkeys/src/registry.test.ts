import { describe, expect, it } from "bun:test";
import type { HotkeyAction, HotkeyRegistry } from "./registry.ts";
import {
	findConflicts,
	groupByCategory,
	resolveAllBindings,
	resolveBinding,
} from "./registry.ts";

function makeAction(
	partial: Partial<HotkeyAction> & { id: string }
): HotkeyAction {
	return {
		category: "General",
		label: partial.id,
		defaultBinding: "Mod+K",
		...partial,
	};
}

describe("resolveBinding", () => {
	it("normalizes the default binding", () => {
		const action = makeAction({ id: "a", defaultBinding: "shift+mod+k" });
		expect(resolveBinding(action, {})).toBe("Mod+Shift+K");
	});

	it("normalizes an override binding", () => {
		const action = makeAction({ id: "a" });
		expect(resolveBinding(action, { a: "shift+mod+y" })).toBe("Mod+Shift+Y");
	});

	it("returns null for a null default binding", () => {
		const action = makeAction({ id: "a", defaultBinding: null });
		expect(resolveBinding(action, {})).toBeNull();
	});

	it("treats an explicit null override as unbound even with a default", () => {
		const action = makeAction({ id: "a", defaultBinding: "Mod+T" });
		expect(resolveBinding(action, { a: null })).toBeNull();
	});

	it("uses the default when the override key is absent", () => {
		const action = makeAction({ id: "a", defaultBinding: "Mod+T" });
		expect(resolveBinding(action, { other: "Mod+Z" })).toBe("Mod+T");
	});

	it("prefers an override that re-binds over the default", () => {
		const action = makeAction({ id: "a", defaultBinding: "Mod+T" });
		expect(resolveBinding(action, { a: "Mod+Y" })).toBe("Mod+Y");
	});
});

describe("resolveAllBindings", () => {
	it("maps every action id to its effective binding", () => {
		const registry: HotkeyRegistry = [
			makeAction({ id: "a", defaultBinding: "Mod+A" }),
			makeAction({ id: "b", defaultBinding: "Mod+B" }),
			makeAction({ id: "c", defaultBinding: null }),
		];
		const map = resolveAllBindings(registry, { b: "Mod+Z" });
		expect(map.get("a")).toBe("Mod+A");
		expect(map.get("b")).toBe("Mod+Z");
		expect(map.get("c")).toBeNull();
		expect(map.size).toBe(3);
	});

	it("returns an empty map for an empty registry", () => {
		expect(resolveAllBindings([], {}).size).toBe(0);
	});
});

describe("findConflicts", () => {
	const base: HotkeyRegistry = [
		makeAction({ id: "tab.new", defaultBinding: "Mod+T" }),
		makeAction({ id: "tab.close", defaultBinding: "Mod+W" }),
	];

	it("reports no conflicts when every chord is unique", () => {
		expect(findConflicts(base, {}).size).toBe(0);
	});

	it("never counts unbound (null) actions as conflicting", () => {
		const registry: HotkeyRegistry = [
			makeAction({ id: "a", defaultBinding: null }),
			makeAction({ id: "b", defaultBinding: null }),
		];
		expect(findConflicts(registry, {}).size).toBe(0);
	});

	it("detects a conflict introduced by an override", () => {
		const conflicts = findConflicts(base, { "tab.close": "Mod+T" });
		expect(conflicts.get("Mod+T")).toEqual(["tab.new", "tab.close"]);
	});

	it("clears a default conflict once one side is rebound", () => {
		const clashing: HotkeyRegistry = [
			makeAction({ id: "a", defaultBinding: "Mod+T" }),
			makeAction({ id: "b", defaultBinding: "Mod+T" }),
		];
		expect(findConflicts(clashing, {}).get("Mod+T")).toEqual(["a", "b"]);
		expect(findConflicts(clashing, { b: "Mod+Y" }).size).toBe(0);
	});

	it("groups three actions sharing one chord", () => {
		const registry: HotkeyRegistry = [
			makeAction({ id: "a", defaultBinding: "Mod+X" }),
			makeAction({ id: "b", defaultBinding: "Mod+X" }),
			makeAction({ id: "c", defaultBinding: "Mod+X" }),
		];
		expect(findConflicts(registry, {}).get("Mod+X")).toEqual(["a", "b", "c"]);
	});

	it("collapses differently-spelled chords onto one canonical key", () => {
		const registry: HotkeyRegistry = [
			makeAction({ id: "a", defaultBinding: "Mod+Shift+K" }),
			makeAction({ id: "b", defaultBinding: "shift+mod+k" }),
		];
		const conflicts = findConflicts(registry, {});
		expect(conflicts.get("Mod+Shift+K")).toEqual(["a", "b"]);
	});
});

describe("groupByCategory", () => {
	it("preserves first-seen category order and within-category order", () => {
		const registry: HotkeyRegistry = [
			makeAction({ id: "a", category: "Tabs" }),
			makeAction({ id: "b", category: "Nav" }),
			makeAction({ id: "c", category: "Tabs" }),
		];
		const groups = groupByCategory(registry);
		expect(groups.map((g) => g.category)).toEqual(["Tabs", "Nav"]);
		expect(groups.at(0)?.actions.map((a) => a.id)).toEqual(["a", "c"]);
		expect(groups.at(1)?.actions.map((a) => a.id)).toEqual(["b"]);
	});

	it("returns no groups for an empty registry", () => {
		expect(groupByCategory([])).toEqual([]);
	});
});
