import { describe, expect, test } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import {
	presetSummaryAxis,
	presetSummaryMessage,
} from "./split-preset-summary.ts";
import {
	BUILTIN_PRESETS,
	makePresetBranch,
	makeSlot,
	presetSummary,
	type SplitPreset,
} from "./splitPresets.ts";

const SOURCE =
	"{count, plural, one {{countText} pane} other {{countText} panes}} · {axis, select, columns {side by side} rows {stacked} other {tiled}}";

const english: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

function catalog(locale: string, translated: string): LiteralMessage {
	return (source, values) => {
		if (source !== SOURCE) {
			throw new Error(`Unexpected message: ${source}`);
		}
		return formatMessage(translated, values, locale);
	};
}

function builtin(id: string): SplitPreset {
	const preset = BUILTIN_PRESETS.find((candidate) => candidate.id === id);
	if (!preset) {
		throw new Error(`Missing builtin preset ${id}`);
	}
	return preset;
}

function custom(orientation: "columns" | "rows", slots: number): SplitPreset {
	return {
		createdAt: 0,
		id: "custom",
		name: "Custom",
		root: makePresetBranch(
			orientation,
			Array.from({ length: slots }, () => makeSlot())
		),
	};
}

describe("presetSummaryMessage", () => {
	test("renders each arrangement as one whole English message", () => {
		expect(presetSummaryMessage(english, builtin("builtin:side-by-side"))).toBe(
			"2 panes · side by side"
		);
		expect(presetSummaryMessage(english, builtin("builtin:stacked"))).toBe(
			"2 panes · stacked"
		);
		expect(presetSummaryMessage(english, builtin("builtin:grid"))).toBe(
			"4 panes · tiled"
		);
	});

	test("keeps the English helper output for non-UI callers", () => {
		for (const preset of BUILTIN_PRESETS) {
			expect(presetSummaryMessage(english, preset)).toBe(presetSummary(preset));
		}
	});

	test("uses the one and other plural forms", () => {
		expect(presetSummaryMessage(english, custom("rows", 1))).toBe(
			"1 pane · stacked"
		);
		expect(presetSummaryMessage(english, custom("columns", 3))).toBe(
			"3 panes · side by side"
		);
	});

	test("classifies nested shapes as tiled, not by their root axis", () => {
		expect(presetSummaryAxis(builtin("builtin:main-and-two-stacked"))).toBe(
			"tiled"
		);
		expect(presetSummaryAxis(custom("columns", 2))).toBe("columns");
		expect(presetSummaryAxis(custom("rows", 2))).toBe("rows");
	});

	test("translates the count and the arrangement word together", () => {
		const de = catalog(
			"de",
			"{count, plural, one {{countText} Bereich} other {{countText} Bereiche}} · {axis, select, columns {nebeneinander} rows {übereinander} other {gekachelt}}"
		);
		expect(presetSummaryMessage(de, custom("rows", 1))).toBe(
			"1 Bereich · übereinander"
		);
		expect(presetSummaryMessage(de, builtin("builtin:side-by-side"))).toBe(
			"2 Bereiche · nebeneinander"
		);
		const summary = presetSummaryMessage(de, builtin("builtin:grid"));
		expect(summary).toBe("4 Bereiche · gekachelt");
		expect(summary).not.toMatch(/panes|tiled|stacked|side by side/);
	});
});
