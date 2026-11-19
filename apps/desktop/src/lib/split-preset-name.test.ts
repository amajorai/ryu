import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { presetDisplayName, suggestPresetName } from "./split-preset-name.ts";
import { BUILTIN_PRESETS } from "./splitPresets.ts";

const english = (source: string) => source;
const JA: Record<string, string> = {
	"2 × 2 grid": "2 × 2 グリッド",
	"Main + two stacked": "メイン + 縦に 2 つ",
	"Side by side": "横に並べる",
	Stacked: "縦に並べる",
	"Three columns": "3 列",
};
const ja = (source: string) => JA[source] ?? source;

test("every built-in preset reads as its stored English name in English", () => {
	for (const preset of BUILTIN_PRESETS) {
		expect(presetDisplayName(english, preset)).toBe(preset.name);
	}
});

test("built-in preset names follow the UI language", () => {
	const names = BUILTIN_PRESETS.map((preset) => presetDisplayName(ja, preset));
	expect(names).toEqual([
		"横に並べる",
		"縦に並べる",
		"3 列",
		"メイン + 縦に 2 つ",
		"2 × 2 グリッド",
	]);
});

test("a user's own preset keeps the name they typed", () => {
	expect(presetDisplayName(ja, { id: "user-1", name: "Three columns" })).toBe(
		"Three columns"
	);
});

test("a suggested preset name is a catalogued phrase with a free number", () => {
	const tl: LiteralMessage = (source, values) =>
		`[${source}]${values ? JSON.stringify(values) : ""}`;
	const base = '[{count}-pane layout]{"count":3}';
	expect(suggestPresetName(3, [], tl)).toBe(base);
	expect(suggestPresetName(3, [base, `${base} 2`], tl)).toBe(`${base} 3`);
});
