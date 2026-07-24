import { describe, expect, it } from "bun:test";
import {
	chordFromElectron,
	chordHasModifier,
	chordMatches,
	chordTokens,
	eventToChord,
	formatChord,
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

	it("tolerates unknown modifier casing", () => {
		expect(normalizeChord("ctrl+alt+x")).toBe("Ctrl+Alt+X");
	});

	it("keeps Ctrl and Mod as distinct modifiers", () => {
		expect(normalizeChord("Ctrl+Mod+K")).toBe("Mod+Ctrl+K");
	});

	it("deduplicates a repeated modifier", () => {
		expect(normalizeChord("Shift+Shift+A")).toBe("Shift+A");
	});

	it("trims whitespace and drops empty parts", () => {
		expect(normalizeChord(" Mod + Shift + K ")).toBe("Mod+Shift+K");
		expect(normalizeChord("Mod++K")).toBe("Mod+K");
	});

	it("upper-cases only single-character main keys, leaving multi-char keys as-is", () => {
		// A single character is upper-cased; a multi-character token keeps its casing.
		expect(normalizeChord("mod+f5")).toBe("Mod+f5");
		expect(normalizeChord("mod+a")).toBe("Mod+A");
	});

	it("normalizes a bare modifier to itself with no main key", () => {
		expect(normalizeChord("shift")).toBe("Shift");
	});

	it("orders modifiers as Mod, Ctrl, Alt, Shift regardless of input", () => {
		expect(normalizeChord("Shift+Alt+Ctrl+Mod+X")).toBe("Mod+Ctrl+Alt+Shift+X");
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

	it("maps the space key to Space", () => {
		expect(eventToChord(key({ ctrlKey: true, key: " " }))).toBe("Mod+Space");
	});

	it("emits Alt-only chords", () => {
		expect(eventToChord(key({ altKey: true, key: "Enter" }))).toBe("Alt+Enter");
	});

	it("returns null for each modifier-only press", () => {
		for (const modKey of ["Control", "Shift", "Alt", "Meta", "OS"]) {
			expect(eventToChord(key({ key: modKey }))).toBeNull();
		}
	});

	it("orders modifiers Mod, Alt, Shift in the raw event chord", () => {
		expect(
			eventToChord(
				key({ ctrlKey: true, altKey: true, shiftKey: true, key: "k" })
			)
		).toBe("Mod+Alt+Shift+K");
	});

	it("upper-cases a single-character main key", () => {
		expect(eventToChord(key({ key: "z" }))).toBe("Z");
	});
});

describe("chordHasModifier", () => {
	it("is false for a bare main key", () => {
		expect(chordHasModifier("K")).toBe(false);
	});

	it("is true when any modifier is present", () => {
		expect(chordHasModifier("Mod+K")).toBe(true);
		expect(chordHasModifier("Ctrl+A")).toBe(true);
		expect(chordHasModifier("Alt+Left")).toBe(true);
		expect(chordHasModifier("Shift+Space")).toBe(true);
	});

	it("tolerates lowercase modifier spelling", () => {
		expect(chordHasModifier("mod+k")).toBe(true);
	});
});

describe("chordTokens", () => {
	it("renders glyphs on macOS", () => {
		expect(chordTokens("Mod+Shift+K", true)).toEqual(["⌘", "⇧", "K"]);
	});

	it("renders words on non-macOS", () => {
		expect(chordTokens("Mod+Shift+K", false)).toEqual(["Ctrl", "Shift", "K"]);
	});

	it("shows the control glyph distinctly from Mod on macOS", () => {
		expect(chordTokens("Ctrl+A", true)).toEqual(["⌃", "A"]);
		expect(chordTokens("Ctrl+A", false)).toEqual(["Ctrl", "A"]);
	});
});

describe("formatChord", () => {
	it("space-joins glyphs on macOS", () => {
		expect(formatChord("Mod+Shift+K", true)).toBe("⌘ ⇧ K");
	});

	it("plus-joins words on non-macOS", () => {
		expect(formatChord("Mod+Shift+K", false)).toBe("Ctrl+Shift+K");
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

	it("maps Ctrl to the Electron Control token and back", () => {
		expect(toElectronAccelerator("Ctrl+A")).toBe("Control+A");
		expect(chordFromElectron("Control+A")).toBe("Ctrl+A");
	});

	it("translates the Enter/Return key across formats", () => {
		expect(toElectronAccelerator("Mod+Enter")).toBe("CommandOrControl+Return");
		expect(chordFromElectron("CommandOrControl+Return")).toBe("Mod+Enter");
	});

	it("translates Esc/Escape across formats", () => {
		expect(toElectronAccelerator("Esc")).toBe("Esc");
		expect(chordFromElectron("Escape")).toBe("Esc");
	});

	it("passes arrow keys through unchanged", () => {
		expect(toElectronAccelerator("Alt+Up")).toBe("Alt+Up");
		expect(chordFromElectron("Alt+Up")).toBe("Alt+Up");
	});

	it("folds every Cmd-family alias into Mod", () => {
		for (const alias of ["CmdOrCtrl", "Command", "Cmd", "Super"]) {
			expect(chordFromElectron(`${alias}+K`)).toBe("Mod+K");
		}
	});

	it("round-trips a plain Mod+Space accelerator", () => {
		expect(toElectronAccelerator("Mod+Space")).toBe("CommandOrControl+Space");
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
