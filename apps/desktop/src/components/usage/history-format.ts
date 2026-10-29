import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";

const COMPACT_TOKENS = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 2,
});
const EXACT_TOKENS = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 0,
});

export function formatHistoryTokens(value: number, compact = true): string {
	return (compact ? COMPACT_TOKENS : EXACT_TOKENS).format(value);
}

export function historyCounterDisplay(
	value: number,
	missing: number | readonly number[],
	records: number
) {
	const missingCounts = isNativeNumber(missing) ? [missing] : missing;
	if (records > 0 && missingCounts.every((count) => count === records)) {
		return { value: "Unknown", detail: "Not reported" };
	}
	return {
		value: formatHistoryTokens(value),
		detail: `${formatHistoryTokens(value, false)}${missingCounts.some((count) => count > 0) ? " · Partial" : ""}`,
	};
}
