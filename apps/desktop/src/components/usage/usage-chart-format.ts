// Locale-aware labels for the usage history chart's axis, tooltip and
// forecast series. Daily buckets are keyed by UTC date, so the dates format in
// UTC; formatting them in the viewer's zone would shift a bucket by a day.

import { dateFormatter } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";

const TICK_OPTIONS: Intl.DateTimeFormatOptions = {
	day: "numeric",
	month: "short",
	timeZone: "UTC",
};
const HEADING_OPTIONS: Intl.DateTimeFormatOptions = {
	dateStyle: "medium",
	timeZone: "UTC",
};

/** The tooltip label of a forecast series, as one catalog message. */
export function forecastLabel(tl: LiteralMessage, source: string): string {
	return tl("{source} forecast", { source });
}

/** A short X-axis tick for a UTC day timestamp, such as "3. Nov." in `de`. */
export function dayTick(locale: string, timestamp: number): string {
	return Number.isFinite(timestamp)
		? dateFormatter(locale, TICK_OPTIONS).format(timestamp)
		: "";
}

/** The tooltip heading for a UTC day timestamp, such as "03.11.2026" in `de`. */
export function dayHeading(locale: string, timestamp: number): string {
	return Number.isFinite(timestamp)
		? dateFormatter(locale, HEADING_OPTIONS).format(timestamp)
		: "";
}
