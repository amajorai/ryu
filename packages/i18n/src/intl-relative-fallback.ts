// `Intl.RelativeTimeFormat` for engines that lack it (Hermes on React Native).
//
// It degrades to the English compact age ("5m", "3h", "2d") in a sentence
// ("5m ago", "in 3h"), and "now" for zero. It is not a polyfill: only
// `format()` is implemented, which is all `format-intl.ts` calls. When the
// engine has the constructor, it is always used instead.
//
// The sentences go through `translate()`, but the extractor does not walk
// `packages/i18n/src` and the native catalog subset carries only the app's
// own copy, so on React Native they read in English. That is the accepted
// degraded output; the @formatjs polyfills are the follow-up if it is not.

import { translate as tl } from "./active-locale.ts";
import { hasIntl } from "./intl-guards.ts";

const COMPACT_SUFFIX: Record<string, string> = {
	day: "d",
	hour: "h",
	minute: "m",
	month: "mo",
	quarter: "q",
	second: "s",
	week: "w",
	year: "y",
};

/** One relative time as the degraded formatter writes it: "5m ago", "in 2d", "now". */
export function formatRelativeFallback(
	value: number,
	unit: Intl.RelativeTimeFormatUnit
): string {
	if (value === 0 || !Number.isFinite(value)) {
		return tl("now");
	}
	const singular = unit.endsWith("s") ? unit.slice(0, -1) : unit;
	const age = `${Math.abs(value)}${COMPACT_SUFFIX[singular] ?? ""}`;
	return value < 0 ? tl("{age} ago", { age }) : tl("in {age}", { age });
}

/**
 * `new Intl.RelativeTimeFormat(locale, { numeric, style })`, or the compact
 * fallback above when the engine has no `RelativeTimeFormat`.
 */
export function relativeTimeFormatOrFallback(
	locale: string,
	numeric: Intl.RelativeTimeFormatNumeric,
	style: Intl.RelativeTimeFormatStyle
): Intl.RelativeTimeFormat {
	if (hasIntl("RelativeTimeFormat")) {
		return new Intl.RelativeTimeFormat(locale, { numeric, style });
	}
	const fallback: Pick<Intl.RelativeTimeFormat, "format"> = {
		format: formatRelativeFallback,
	};
	// Only `format()` is ever called on the cached formatter (see format-intl.ts).
	return fallback as Intl.RelativeTimeFormat;
}
