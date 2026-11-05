import type { LiteralMessage } from "@ryu/i18n/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import {
	presetIsNested,
	presetSlotCount,
	type SplitPreset,
} from "./splitPresets.ts";

export type PresetSummaryAxis = "columns" | "rows" | "tiled";

/** Which arrangement a preset describes. A nested shape is "tiled" rather than
    named after its root axis: a 2 × 2 grid has a `columns` root, but calling it
    "side by side" would describe the wrong layout. */
export function presetSummaryAxis(preset: SplitPreset): PresetSummaryAxis {
	if (presetIsNested(preset.root)) {
		return "tiled";
	}
	return preset.root.orientation === "columns" ? "columns" : "rows";
}

/** The menu-row summary ("3 panes · side by side") as one whole translated
    message, so the pane count gets the locale's plural form and digits and the
    arrangement word is translated with it. `presetSummary` in
    `splitPresets.ts` stays the English form for non-UI callers. */
export function presetSummaryMessage(
	tl: LiteralMessage,
	preset: SplitPreset
): string {
	const count = presetSlotCount(preset.root);
	return tl(
		"{count, plural, one {{countText} pane} other {{countText} panes}} · {axis, select, columns {side by side} rows {stacked} other {tiled}}",
		{
			axis: presetSummaryAxis(preset),
			count,
			countText: formatCount(count) ?? String(count),
		}
	);
}
