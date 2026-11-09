import { describe, expect, test } from "bun:test";
import { chordKeyLabel } from "./chord-key-label.ts";

const english = (source: string) => source;

const JA: Record<string, string> = {
	"Escape key": "Esc キー",
	"Page Down key": "Page Down キー",
	"Space key": "スペースキー",
};
const japanese = (source: string) => JA[source] ?? source;

describe("chordKeyLabel", () => {
	test("arrow tokens render as direction glyphs in every locale", () => {
		expect(chordKeyLabel("Up", japanese)).toBe("↑");
		expect(chordKeyLabel("Down", japanese)).toBe("↓");
		expect(chordKeyLabel("Left", english)).toBe("←");
		expect(chordKeyLabel("Right", english)).toBe("→");
	});

	test("named keys translate in their keyboard-key sense", () => {
		expect(chordKeyLabel("Space", japanese)).toBe("スペースキー");
		expect(chordKeyLabel("PageDown", japanese)).toBe("Page Down キー");
		expect(chordKeyLabel("Esc", japanese)).toBe("Esc キー");
		expect(chordKeyLabel("Escape", japanese)).toBe("Esc キー");
	});

	test("an untranslated key-sense message falls back to the short token", () => {
		expect(chordKeyLabel("Space", english)).toBe("Space");
		expect(chordKeyLabel("End", english)).toBe("End");
		expect(chordKeyLabel("Home", japanese)).toBe("Home");
	});

	test("modifier keys translate in their keyboard-key sense", () => {
		const german = (source: string) =>
			({ "Ctrl key": "Strg", "Shift key": "Umschalt" })[source] ?? source;
		expect(chordKeyLabel("Shift", german)).toBe("Umschalt");
		expect(chordKeyLabel("Ctrl", german)).toBe("Strg");
		expect(chordKeyLabel("Alt", german)).toBe("Alt");
		expect(chordKeyLabel("Shift", english)).toBe("Shift");
	});

	test("other tokens are returned unchanged and never translated", () => {
		const everything = () => "翻訳";
		expect(chordKeyLabel("K", everything)).toBe("K");
		expect(chordKeyLabel("F5", everything)).toBe("F5");
		expect(chordKeyLabel("⌘", everything)).toBe("⌘");
		expect(chordKeyLabel("⇧", everything)).toBe("⇧");
	});
});
