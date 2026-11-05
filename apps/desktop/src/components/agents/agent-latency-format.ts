import { formatDurationUnit } from "@ryu/i18n/format-intl";

/**
 * A latency readout in the reader's number format and unit: "420ms" in
 * English, "420 ملي ث" in Arabic, "420 ms" in German. Missing values read as an
 * em dash. Fractional latencies round to whole milliseconds.
 */
export function formatLatencyMs(
	value: number | null | undefined,
	locale?: string
): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	return formatDurationUnit(Math.round(value), "millisecond", 0, locale);
}
