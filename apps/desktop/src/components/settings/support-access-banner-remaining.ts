// apps/desktop/src/components/settings/support-access-banner-remaining.ts
//
// The support-access banner's "expires in N" clause. Each variant is its own
// translated phrase, and the duration uses the active locale's units, so the
// banner sentence never ends half in English.

import type { MessageValuesInput } from "@ryu/i18n/core";
import { activeLocale, isEnglishLocale } from "@ryu/i18n/core";
import { type DurationUnit, formatDurationParts } from "@ryu/i18n/format-intl";

type Translate = (message: string, values?: MessageValuesInput) => string;

/** "1 h 30 min" in English (the banner's long-standing form); the locale's own units elsewhere. */
export function formatRemainingDuration(
	hours: number,
	minutes: number,
	locale: string = activeLocale()
): string {
	const parts: [number, DurationUnit][] = [];
	if (hours > 0) {
		parts.push([hours, "hour"]);
	}
	if (minutes > 0 || hours === 0) {
		parts.push([minutes, "minute"]);
	}
	if (!isEnglishLocale(locale)) {
		return formatDurationParts(parts, locale);
	}
	return parts
		.map(([value, unit]) => `${value} ${unit === "hour" ? "h" : "min"}`)
		.join(" ");
}

/** The banner's remaining-time clause, translated as its own phrase. */
export function formatSupportAccessRemaining(
	expiryMs: number,
	nowMs: number,
	tl: Translate,
	locale: string = activeLocale()
): string {
	if (expiryMs === 0) {
		return tl("no expiry set");
	}
	const remaining = expiryMs - nowMs;
	if (remaining <= 0) {
		return tl("expiring");
	}
	// Floor to whole hours and surface the leftover minutes so we never overstate
	// the time left (e.g. 90 min reads "1 h 30 min", not "2 h").
	const minutes = Math.floor(remaining / 60_000);
	return tl("expires in {duration}", {
		duration: formatRemainingDuration(
			Math.floor(minutes / 60),
			minutes % 60,
			locale
		),
	});
}
