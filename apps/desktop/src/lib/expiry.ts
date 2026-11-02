// apps/desktop/src/lib/expiry.ts
//
// One convention for rendering "money/credit that lapses on a date".
//
// Two surfaces now show that shape and they must read identically: the composer
// usage bar's Codex banked rate-limit resets (each credit expires on its own
// date) and the agent picker's per-pool Ryu grant balances (a campaign grant
// lapses on its own date). These lived in `usage-bar.tsx` first; they moved here
// the moment the second consumer appeared rather than being copied, because two
// drifting "expires in" formats on the same screen is exactly the sort of thing
// nobody notices until a user asks why one says "6d" and the other "in ~1w".

import { activeLocale, isEnglishLocale, numberFormatter } from "@ryu/i18n/core";
import { type DurationUnit, formatDurationUnit } from "@ryu/i18n/format-intl";
import { formatDateTime } from "@/src/lib/timezone.ts";

const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = 3600;
const HOURS_IN_WEEK = HOURS_PER_DAY * 7;
const URGENT_EXPIRY_HOURS = 48;

/** "Jul 31 at 5:30 PM" — the exact moment something lapses. */
export function formatExpiryDate(iso: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) {
		return iso;
	}
	return formatDateTime(ms, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/** A countdown unit: the shared duration units plus whole days. */
export type SpanUnit = DurationUnit | "day";

/** CJK/Hangul unit gap, so a span reads "3日" and "3일", not "3 日". */
const SPAN_UNIT_GAP =
	/(\d)[\s\u00a0\u202f]+(?=[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af])/gu;

function formatSpanUnit(value: number, unit: SpanUnit, locale: string): string {
	if (unit !== "day") {
		return formatDurationUnit(value, unit, 0, locale);
	}
	if (isEnglishLocale(locale)) {
		return `${value}d`;
	}
	return numberFormatter(locale, {
		maximumFractionDigits: 0,
		style: "unit",
		unit: "day",
		unitDisplay: "short",
	})
		.format(value)
		.replace(SPAN_UNIT_GAP, "$1");
}

/**
 * Whole-number span parts joined in order: `[[2, "day"], [4, "hour"]]` reads
 * "2d 4h" in English (the compact form these countdowns always used) and the
 * locale's own short units elsewhere ("2日 4時間", "2 Tg. 4 Std.").
 */
export function formatDurationSpan(
	parts: ReadonlyArray<readonly [number, SpanUnit]>,
	locale: string = activeLocale()
): string {
	return parts
		.map(([value, unit]) => formatSpanUnit(value, unit, locale))
		.join(" ");
}

/** Sentinel {@link formatCountdown} returns once `iso` has passed. */
export const COUNTDOWN_EXPIRED = "expired";

/**
 * "12d 18h" / "4h" / "23m" (in the active locale's units) — the countdown to
 * `iso`, {@link COUNTDOWN_EXPIRED} once it has passed, or "" when unparseable.
 */
export function formatCountdown(
	iso: string,
	now: number = Date.now(),
	locale: string = activeLocale()
): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) {
		return "";
	}
	const minutes = Math.round((ms - now) / 60_000);
	if (minutes <= 0) {
		return COUNTDOWN_EXPIRED;
	}
	if (minutes < 60) {
		return formatDurationSpan([[minutes, "minute"]], locale);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < HOURS_PER_DAY) {
		return formatDurationSpan([[hours, "hour"]], locale);
	}
	const days = Math.floor(hours / HOURS_PER_DAY);
	return formatDurationSpan(
		[
			[days, "day"],
			[hours % HOURS_PER_DAY, "hour"],
		],
		locale
	);
}

/**
 * Urgency hue for an expiry, matching CodexBar's convention: calm beyond a week,
 * amber within a week, red within 48 hours. What makes an expiring balance worth
 * acting on is that it's about to be *lost*, so the soonest date drives it.
 */
export function expiryClass(iso: string): string {
	const hours = (Date.parse(iso) - Date.now()) / (1000 * SECONDS_PER_HOUR);
	if (Number.isNaN(hours)) {
		return "bg-muted-foreground/40";
	}
	if (hours <= URGENT_EXPIRY_HOURS) {
		return "bg-destructive";
	}
	if (hours <= HOURS_IN_WEEK) {
		return "bg-warning";
	}
	return "bg-info";
}
