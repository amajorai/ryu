// Codex-style compact relative age used by the sidebar and home recents list.
//
// Both helpers format in the UI language (`activeLocale()`), so model code and
// components share one spelling without threading `useI18n()` through. English
// output is unchanged ("5m", "5m ago"); other locales use their own units
// ("5分", "5分前") rather than Latin suffixes the DOM localizer cannot patch.

import {
	activeLocale,
	formatCompactAge,
	formatRelativeTime,
	isEnglishLocale,
	relativeTimeFormatter,
} from "@ryu/i18n/core";

const PRESENCE_NOW_SECONDS = 10;
const SECONDS_PER_MINUTE = 60;

/**
 * Compact relative age for list badges: "now", "5m", "1h", "3d", "2w", "4mo",
 * "1y" in English, the locale's narrow units elsewhere ("5分", "5 мин").
 * Display only: never use the result as a sort or dedupe key.
 */
export function compactAge(
	timestamp: number,
	locale: string = activeLocale()
): string {
	return formatCompactAge(locale, timestamp);
}

/**
 * A full "… ago" phrase: "just now", "5m ago", "3h ago" in English (the
 * compact form the sidebar always used), the locale's own relative phrase
 * elsewhere ("5 分前", "5 мин. назад", "vor 5 Min."). Use it instead of a
 * "{age} ago" message around `compactAge`, which cannot be translated.
 */
export function compactAgo(
	timestamp: number,
	locale: string = activeLocale()
): string {
	if (isEnglishLocale(locale)) {
		const age = formatCompactAge(locale, timestamp);
		return age === "now" ? "just now" : `${age} ago`;
	}
	return formatRelativeTime(locale, timestamp, { style: "short" });
}

/**
 * Presence freshness with seconds: "now" under ten seconds, then "12s ago",
 * then `compactAgo` ("5m ago", "5 分前", "12 秒前"). For live last-seen stamps.
 */
export function presenceAgo(
	timestamp: number,
	locale: string = activeLocale(),
	now: number = Date.now()
): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < PRESENCE_NOW_SECONDS) {
		return isEnglishLocale(locale)
			? "now"
			: formatRelativeTime(locale, now, { now });
	}
	if (seconds < SECONDS_PER_MINUTE) {
		return isEnglishLocale(locale)
			? `${seconds}s ago`
			: relativeTimeFormatter(locale, "short", "always").format(
					-seconds,
					"second"
				);
	}
	return compactAgo(timestamp, locale);
}

/**
 * A long relative phrase in the UI language: "5 minutes ago", "yesterday",
 * "5 分前". Replaces date-fns `formatDistanceToNow`, which only speaks English.
 * An invalid date returns an empty string.
 */
export function relativeTimeAgo(
	value: Date | number | string,
	locale: string = activeLocale()
): string {
	return formatRelativeTime(locale, value);
}
