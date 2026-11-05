// The composer usage badges and meters show "42%" in English, "42 %" in
// German and French and Arabic-Indic digits in Arabic, like every other
// percentage formatted through `formatPercent`.

import { activeLocale } from "@ryu/i18n/core";
import { formatPercent } from "@ryu/i18n/format-percent";

/** A 0-100 usage value as a whole-number percentage in `locale`. */
export function usagePercentText(
	used: number,
	locale: string = activeLocale()
): string {
	return formatPercent(Math.round(used) / 100, 0, locale);
}
