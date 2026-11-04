// A number with exactly `digits` decimals in the reader's number format:
// "0.873" in English, "0,873" in German. A hand-written `value.toFixed(n)`
// always uses an ASCII "." and is what the --label-values gate rejects inside
// a message; scores, thresholds and slider readouts call this instead.

import { activeLocale } from "@ryu/i18n/core";
import { formatNumberValue } from "@ryu/i18n/format-intl";

export function formatFixedDecimals(
	value: number,
	digits: number,
	locale: string | null | undefined = activeLocale()
): string {
	return formatNumberValue(locale, value, {
		maximumFractionDigits: digits,
		minimumFractionDigits: digits,
	});
}
