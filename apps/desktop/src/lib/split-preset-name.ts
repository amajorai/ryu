import type { LiteralMessage } from "@ryu/i18n/react";
import type { SplitPreset } from "./splitPresets.ts";

/** A preset's name as the menu shows it. Built-in presets keep an English
    `name` in `splitPresets.ts` for storage and non-UI callers; here each one
    resolves by id to a whole catalog literal. A user's own preset shows the
    name they typed. */
export function presetDisplayName(
	tl: LiteralMessage,
	preset: Pick<SplitPreset, "id" | "name">
): string {
	switch (preset.id) {
		case "builtin:side-by-side":
			return tl("Side by side");
		case "builtin:stacked":
			return tl("Stacked");
		case "builtin:three-columns":
			return tl("Three columns");
		case "builtin:main-and-two-stacked":
			return tl("Main + two stacked");
		case "builtin:grid":
			return tl("2 × 2 grid");
		default:
			return preset.name;
	}
}

/**
 * Suggest a name for a new preset from its pane count, in the saver's
 * language (the name is stored as typed), so saving is one keystroke for most
 * users. A taken name gets the next free number.
 */
export function suggestPresetName(
	paneCount: number,
	taken: readonly string[],
	tl: LiteralMessage
): string {
	const base = tl("{count}-pane layout", { count: paneCount });
	const isTaken = (candidate: string) =>
		taken.some((name) => name.toLowerCase() === candidate.toLowerCase());
	if (!isTaken(base)) {
		return base;
	}
	let n = 2;
	while (isTaken(`${base} ${n}`)) {
		n += 1;
	}
	return `${base} ${n}`;
}
