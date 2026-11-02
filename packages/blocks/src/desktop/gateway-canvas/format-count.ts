// Compact traffic counts for the gateway canvas. English keeps the canvas's
// own short form (980, 1.2k, 34k, 1.1M) byte for byte; every other locale gets
// its own compact notation and decimal separator ("1,2 Mio." in de, "1.2万"
// in ja) through `formatCompactNumber`.

import { activeLocale, isEnglishLocale } from "@ryu/i18n/core";
import { formatCompactNumber } from "../agent-elements/locale-format.ts";

/** Compact counts: 980, 1.2k, 34k, 1.1M in English; the locale's form elsewhere. */
export function formatCount(
	value: number,
	locale: string = activeLocale()
): string {
	if (!isEnglishLocale(locale)) {
		return formatCompactNumber(value, locale);
	}
	if (value < 1000) {
		return String(value);
	}
	if (value < 10_000) {
		return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	}
	if (value < 1_000_000) {
		return `${Math.round(value / 1000)}k`;
	}
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
