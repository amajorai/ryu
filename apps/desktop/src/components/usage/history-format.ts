import { activeLocale, numberFormatter, translate as tl } from "@ryu/i18n/core";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";

const COMPACT_TOKENS: Intl.NumberFormatOptions = {
	notation: "compact",
	maximumFractionDigits: 2,
};
const EXACT_TOKENS: Intl.NumberFormatOptions = {
	maximumFractionDigits: 0,
};

/** "6.98B" / "69.8億" (compact) or "6,979,600,123" in the UI language. */
export function formatHistoryTokens(
	value: number,
	compact = true,
	locale: string = activeLocale()
): string {
	return numberFormatter(
		locale,
		compact ? COMPACT_TOKENS : EXACT_TOKENS
	).format(value);
}

export function historyCounterDisplay(
	value: number,
	missing: number | readonly number[],
	records: number,
	locale: string = activeLocale()
) {
	const missingCounts = isNativeNumber(missing) ? [missing] : missing;
	if (records > 0 && missingCounts.every((count) => count === records)) {
		return { value: tl("Unknown"), detail: tl("Not reported") };
	}
	const exact = formatHistoryTokens(value, false, locale);
	return {
		value: formatHistoryTokens(value, true, locale),
		detail: missingCounts.some((count) => count > 0)
			? tl("{exact} · Partial", { exact })
			: exact,
	};
}
