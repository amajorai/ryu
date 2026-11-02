// Locale-aware counts and durations for the stats footer. English keeps the
// footer's existing lowercase compact suffixes ("12k", "1.2m") and "1m 5s"
// durations; other locales use their own compact notation and units.

import { activeLocale, isEnglishLocale, numberFormatter } from "@ryu/i18n/core";
import { formatCompactNumber, formatDurationParts } from "./locale-format.ts";

const THOUSAND = 1000;
const MILLION = 1_000_000;
const SECONDS_PER_MINUTE = 60;

function englishStatsCount(value: number): string {
	if (Math.abs(value) >= MILLION) {
		return `${(value / MILLION).toFixed(value >= 10 * MILLION ? 0 : 1)}m`;
	}
	if (Math.abs(value) >= THOUSAND) {
		return `${(value / THOUSAND).toFixed(value >= 10 * THOUSAND ? 0 : 1)}k`;
	}
	return Math.round(value).toLocaleString("en-US");
}

/** "842", "12k", "1.2m" in en; the locale's compact notation elsewhere. */
export function formatStatsCount(
	value: number | undefined,
	locale: string = activeLocale()
): string | null {
	if (value === undefined || !Number.isFinite(value)) {
		return null;
	}
	if (isEnglishLocale(locale)) {
		return englishStatsCount(value);
	}
	if (Math.abs(value) >= THOUSAND) {
		return formatCompactNumber(value, locale);
	}
	return numberFormatter(locale, { maximumFractionDigits: 0 }).format(
		Math.round(value)
	);
}

/** "42s" or "3m 5s" in en (rounded up to the second); localized units elsewhere. */
export function formatStatsDuration(
	milliseconds: number,
	locale: string = activeLocale()
): string {
	const seconds = Math.max(0, Math.ceil(milliseconds / THOUSAND));
	if (seconds < SECONDS_PER_MINUTE) {
		return formatDurationParts([[seconds, "second"]], locale);
	}
	return formatDurationParts(
		[
			[Math.floor(seconds / SECONDS_PER_MINUTE), "minute"],
			[seconds % SECONDS_PER_MINUTE, "second"],
		],
		locale
	);
}
