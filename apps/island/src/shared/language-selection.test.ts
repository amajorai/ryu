import { describe, expect, test } from "bun:test";
import {
	languageSelectionKey,
	parseSelectedPackId,
	parseUiLanguageSelection,
	selectionFromLanguagePacks,
} from "./language-selection.ts";

describe("UI language selection", () => {
	test("parses the saved preference and rejects anything else", () => {
		expect(
			parseUiLanguageSelection('{"mode":"fixed","packId":"official/fr"}')
		).toEqual({ mode: "fixed", packId: "official/fr" });
		expect(parseUiLanguageSelection('{"mode":"auto"}')).toEqual({
			mode: "auto",
			packId: null,
		});
		expect(parseUiLanguageSelection('{"mode":"other"}')).toBeNull();
		expect(parseUiLanguageSelection("not json")).toBeNull();
		expect(parseUiLanguageSelection(null)).toBeNull();
	});

	test("reads the selection a catalog answer carries", () => {
		expect(
			selectionFromLanguagePacks({
				available: true,
				packs: [],
				selection: { mode: "fixed", packId: null },
			} as never)
		).toEqual({ mode: "fixed", packId: null });
		expect(
			selectionFromLanguagePacks({ available: true, packs: [] })
		).toBeNull();
		expect(
			selectionFromLanguagePacks({ available: false, reason: "down" })
		).toBeNull();
	});

	test("keys change only when the effective choice changes", () => {
		expect(languageSelectionKey(null)).toBe("local");
		expect(languageSelectionKey({ mode: "auto", packId: "official/de" })).toBe(
			"auto"
		);
		expect(languageSelectionKey({ mode: "fixed", packId: null })).toBe(
			"fixed:"
		);
		expect(languageSelectionKey({ mode: "fixed", packId: "official/ja" })).toBe(
			"fixed:official/ja"
		);
	});

	test("accepts only a bounded pack id or null from the renderer", () => {
		expect(parseSelectedPackId("official/ar")).toBe("official/ar");
		expect(parseSelectedPackId(null)).toBeNull();
		expect(parseSelectedPackId("")).toBeUndefined();
		expect(parseSelectedPackId(42)).toBeUndefined();
		expect(parseSelectedPackId("x".repeat(129))).toBeUndefined();
	});
});
