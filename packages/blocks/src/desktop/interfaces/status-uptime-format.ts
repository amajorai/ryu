// packages/blocks/src/desktop/interfaces/status-uptime-format.ts
//
// The uptime percentage a Status page shows beside each component. A
// hand-written `toFixed(2)` printed "99.87" for every reader, so German pages
// showed an English decimal point and Arabic pages Latin digits.

import { activeLocale, numberFormatter } from "@ryu/i18n/lite";

const TWO_DECIMALS: Intl.NumberFormatOptions = {
	maximumFractionDigits: 2,
	minimumFractionDigits: 2,
};
const WHOLE: Intl.NumberFormatOptions = { maximumFractionDigits: 0 };

/** A 0..1 share as a percentage, truncated (never rounded up) to two decimals
 *  in the UI language ("99.87", "99,87"). A full share reads "100", with no
 *  decimals, so a perfect record never looks like "100.00". */
export function formatUptime(
	share: number,
	locale: string = activeLocale()
): string {
	const percent = Math.floor(share * 10_000) / 100;
	return percent >= 100
		? numberFormatter(locale, WHOLE).format(100)
		: numberFormatter(locale, TWO_DECIMALS).format(percent);
}
