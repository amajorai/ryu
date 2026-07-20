import { describe, expect, it } from "bun:test";
import {
	chordFromElectron,
	chordMatches,
	eventToChord,
	normalizeChord,
	toElectronAccelerator,
} from "./chord.ts";
import { findConflicts, resolveBinding } from "./registry.ts";

const key = (init: Partial<KeyboardEvent>): KeyboardEvent =>
	init as unknown as KeyboardEvent;

describe("normalizeChord", () => {
	it("reorders modifiers and upper-cases the main key", () => {
		expect(normalizeChord("shift+mod+k")).toBe("Mod+Shift+K");
	});

	it("is idempotent", () => {
		expect(normalizeChord(normalizeChord("Alt+Left"))).toBe("Alt+Left");
	});
});

describe("eventToChord", () => {
	it("folds Ctrl and Cmd into Mod", () => {
		expect(eventToChord(key({ ctrlKey: true, key: "k" }))).toBe("Mod+K");
		expect(eventToChord(key({ metaKey: true, key: "k" }))).toBe("Mod+K");
	});

	it("keeps Shift distinct", () => {
		expect(eventToChord(key({ metaKey: true, shiftKey: true, key: "T" }))).toBe(
			"Mod+Shift+T"
		);
	});

	it("returns null for a modifier-only press", () => {
		expect(eventToChord(key({ ctrlKey: true, key: "Control" }))).toBeNull();
	});

	it("maps named keys", () => {
		expect(eventToChord(key({ altKey: true, key: "ArrowLeft" }))).toBe(
			"Alt+Left"
		);
	});
});

describe("chordMatches", () => {
	it("matches regardless of spelling", () => {
		expect(chordMatches("Mod+K", key({ metaKey: true, key: "k" }))).toBe(true);
	});

	it("does not match when Shift differs", () => {
		expect(
			chordMatches("Mod+T", key({ metaKey: true, shiftKey: true, key: "T" }))
		).toBe(false);
	});
});

describe("electron accelerator bridge", () => {
	it("round-trips through the electron format", () => {
		const chord = "Mod+Shift+A";
		const accelerator = toElectronAccelerator(chord);
		expect(accelerator).toBe("CommandOrControl+Shift+A");
		expect(chordFromElectron(accelerator)).toBe(chord);
	});

	it("reads the island's default summon accelerator", () => {
		expect(chordFromElectron("CommandOrControl+Shift+Space")).toBe(
			"Mod+Shift+Space"
		);
	});
});

describe("registry resolution", () => {
	const action = {
		id: "tab.new",
		label: "New tab",
		category: "Tabs",
		defaultBinding: "Mod+T",
	};

	it("uses the default when no override exists", () => {
		expect(resolveBinding(action, {})).toBe("Mod+T");
	});

	it("applies a rebinding override", () => {
		expect(resolveBinding(action, { "tab.new": "Mod+Y" })).toBe("Mod+Y");
	});

	it("treats a null override as unbound", () => {
		expect(resolveBinding(action, { "tab.new": null })).toBeNull();
	});

	it("detects a conflict between two actions on the same chord", () => {
		const registry = [
			action,
			{
				id: "tab.close",
				label: "Close tab",
				category: "Tabs",
				defaultBinding: "Mod+T",
			},
		];
		const conflicts = findConflicts(registry, {});
		expect(conflicts.get("Mod+T")).toEqual(["tab.new", "tab.close"]);
	});
});
