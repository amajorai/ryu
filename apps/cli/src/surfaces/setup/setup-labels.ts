// Setup screen labels built around catalogued words: the step chips ("[2
// Providers]") and a catalog row's "recommended" badge. Each word is translated
// before the number and brackets are added.

import { tr } from "../../i18n/translate.ts";

/** A catalog row's badge: its install state, else "recommended", else none. */
export function catalogBadge(
	state: string | null | undefined,
	recommended: boolean
): string | undefined {
	if (state && state !== "not_installed") {
		return state;
	}
	return recommended ? tr("recommended") : undefined;
}

/** A step chip ("2 Providers"), bracketed when it is the current step. */
export function stepLabel(index: number, title: string, active: boolean) {
	const label = `${index + 1} ${tr(title)}`;
	return active ? `[${label}]` : label;
}
