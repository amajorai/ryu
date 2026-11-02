// apps/desktop/src/components/chat/RunTracePanel-format.ts
//
// Locale-aware span durations and token counts for the run trace panel.
// English keeps the panel's compact "250ms" / "1.50s" / "1.5k" forms; other
// locales use their own decimal separators, units and compact notation.

import {
	activeLocale,
	isEnglishLocale,
	numberFormatter,
	translate as tl,
} from "@ryu/i18n/core";
import { formatDurationUnit } from "@ryu/i18n/format-intl";

const THOUSAND = 1000;
const TEN_SECONDS_MS = 10_000;

/** A span's duration, or "in flight" while it is still open. */
export function formatDuration(
	ms: number | null,
	locale: string = activeLocale()
): string {
	if (ms === null) {
		return tl("in flight");
	}
	if (ms < THOUSAND) {
		return formatDurationUnit(
			Math.max(0, Math.round(ms)),
			"millisecond",
			0,
			locale
		);
	}
	return formatDurationUnit(
		ms / THOUSAND,
		"second",
		ms < TEN_SECONDS_MS ? 2 : 1,
		locale
	);
}

/** "842" / "1.5k" in English; the locale's compact notation elsewhere. */
export function formatTokens(
	count: number,
	locale: string = activeLocale()
): string {
	if (isEnglishLocale(locale)) {
		return count >= THOUSAND
			? `${(count / THOUSAND).toFixed(1)}k`
			: String(count);
	}
	return numberFormatter(
		locale,
		count >= THOUSAND
			? { maximumFractionDigits: 1, notation: "compact" }
			: { maximumFractionDigits: 0 }
	).format(count);
}
