// Palette entries in the reader's language. The label shows translated, and
// the English label joins the aliases, so a Japanese reader finds "Close tab"
// by typing either タブ or "close".

import { tr } from "../i18n/translate.ts";
import type { PaletteAction } from "./CommandPalette-registry.ts";

/**
 * Translate `action.label` (a catalogued literal) and keep `englishLabel`
 * searchable. Pass `englishLabel` when the label was already composed in the
 * reader's language (`tf("Go to {label}", …)`).
 */
export function localizePaletteAction<T extends PaletteAction>(
	action: T,
	englishLabel: string = action.label
): T {
	const label = tr(action.label);
	if (label === englishLabel) {
		return action;
	}
	return {
		...action,
		aliases: [...(action.aliases ?? []), englishLabel],
		label,
	};
}
