// Cached `Intl` formatters and the relative-time helpers built on them.
//
// Constructing an `Intl.*Format` costs far more than formatting with one, and
// list rows format thousands of dates and ages per render, so every formatter
// is cached by locale and options. An invalid or empty locale falls back to
// English instead of throwing, so model code can pass whatever it was given.
//
// The compact duration helpers (`formatDurationUnit`, `formatDurationParts`)
// default to the language the UI is showing (`activeLocale()`), so model code
// without `useI18n()` formats durations in the active language too, as do the
// byte-size, per-period and week-start helpers at the end of this file.

import { activeLocale, translate as tl } from "./active-locale.ts";
import { DEFAULT_LOCALE } from "./pack.ts";

/** Most formatters one cache keeps before it starts over. */
const FORMATTER_CACHE_LIMIT = 256;

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;
const MS_PER_SECOND = 1000;

/** Units the relative-time helpers count in, smallest first. */
export type RelativeTimeUnit =
	| "second"
	| "minute"
	| "hour"
	| "day"
	| "week"
	| "month"
	| "year";

export type DateInput = Date | number | string;

export interface RelativeTimeOptions {
	/** The moment `value` is relative to; defaults to `Date.now()`. */
	now?: DateInput;
	/** `"auto"` (default) says "yesterday" and "now" where the locale has words for them. */
	numeric?: Intl.RelativeTimeFormatNumeric;
	/** `"long"` (default) "5 minutes ago", `"short"` "5 min. ago", `"narrow"` "5m ago". */
	style?: Intl.RelativeTimeFormatStyle;
}

export interface CompactAgeOptions {
	/** The moment the age is measured at; defaults to `Date.now()`. */
	now?: DateInput;
}

class FormatterCache<Formatter> {
	private readonly entries = new Map<string, Formatter>();

	get(key: string, create: () => Formatter): Formatter {
		const cached = this.entries.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const created = create();
		if (this.entries.size >= FORMATTER_CACHE_LIMIT) {
			this.entries.clear();
		}
		this.entries.set(key, created);
		return created;
	}
}

const dateFormatters = new FormatterCache<Intl.DateTimeFormat>();
const numberFormatters = new FormatterCache<Intl.NumberFormat>();
const relativeFormatters = new FormatterCache<Intl.RelativeTimeFormat>();
const compactUnitDisplays = new FormatterCache<"narrow" | "short">();

function cacheKey(locale: string, options: object | undefined): string {
	return `${locale}\u0000${options ? JSON.stringify(options) : ""}`;
}

/** Build a formatter for `locale`, or for English when the tag is unusable. */
function withFallback<Formatter>(
	locale: string | null | undefined,
	create: (resolved: string) => Formatter
): Formatter {
	if (locale) {
		try {
			return create(locale);
		} catch {
			// An invalid tag or an option this engine lacks: English below.
		}
	}
	return create(DEFAULT_LOCALE);
}

/** A cached `Intl.DateTimeFormat` for `locale` and `options`. */
export function dateFormatter(
	locale: string | null | undefined,
	options?: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
	return dateFormatters.get(cacheKey(locale ?? "", options), () =>
		withFallback(locale, (resolved) => {
			return new Intl.DateTimeFormat(resolved, options);
		})
	);
}

/** A cached `Intl.NumberFormat` for `locale` and `options`. */
export function numberFormatter(
	locale: string | null | undefined,
	options?: Intl.NumberFormatOptions
): Intl.NumberFormat {
	return numberFormatters.get(cacheKey(locale ?? "", options), () =>
		withFallback(locale, (resolved) => {
			return new Intl.NumberFormat(resolved, options);
		})
	);
}

/** A cached `Intl.RelativeTimeFormat`; `numeric` defaults to `"auto"`. */
export function relativeTimeFormatter(
	locale: string | null | undefined,
	style: Intl.RelativeTimeFormatStyle = "long",
	numeric: Intl.RelativeTimeFormatNumeric = "auto"
): Intl.RelativeTimeFormat {
	return relativeFormatters.get(
		cacheKey(locale ?? "", { numeric, style }),
		() =>
			withFallback(locale, (resolved) => {
				return new Intl.RelativeTimeFormat(resolved, { numeric, style });
			})
	);
}

/** A cached unit formatter (`5 min`, `5分`), narrow by default. */
export function unitFormatter(
	locale: string | null | undefined,
	unit: string,
	unitDisplay: Intl.NumberFormatOptions["unitDisplay"] = "narrow"
): Intl.NumberFormat {
	return numberFormatter(locale, { style: "unit", unit, unitDisplay });
}

/** Format a date with a cached formatter (an invalid date throws, as `Intl` does). */
export function formatDateValue(
	locale: string | null | undefined,
	value: DateInput,
	options?: Intl.DateTimeFormatOptions
): string {
	return dateFormatter(locale, options).format(new Date(value));
}

/** Format a number with a cached formatter. */
export function formatNumberValue(
	locale: string | null | undefined,
	value: number,
	options?: Intl.NumberFormatOptions
): string {
	return numberFormatter(locale, options).format(value);
}

function elapsedSeconds(value: DateInput, now: DateInput | undefined): number {
	const at = new Date(value).getTime();
	const reference = now === undefined ? Date.now() : new Date(now).getTime();
	return (at - reference) / MS_PER_SECOND;
}

/** The unit and whole count a signed number of seconds reads best in. */
export function relativeTimeParts(seconds: number): {
	unit: RelativeTimeUnit;
	value: number;
} {
	const sign = seconds < 0 ? -1 : 1;
	const absolute = Math.abs(seconds);
	const minutes = Math.floor(absolute / SECONDS_PER_MINUTE);
	const hours = Math.floor(minutes / MINUTES_PER_HOUR);
	const days = Math.floor(hours / HOURS_PER_DAY);
	const signed = (count: number) => (count === 0 ? 0 : sign * count);
	if (minutes < 1) {
		return { unit: "second", value: signed(Math.floor(absolute)) };
	}
	if (hours < 1) {
		return { unit: "minute", value: signed(minutes) };
	}
	if (days < 1) {
		return { unit: "hour", value: signed(hours) };
	}
	if (days < DAYS_PER_WEEK) {
		return { unit: "day", value: signed(days) };
	}
	if (days < DAYS_PER_MONTH) {
		return { unit: "week", value: signed(Math.floor(days / DAYS_PER_WEEK)) };
	}
	if (days < DAYS_PER_YEAR) {
		return { unit: "month", value: signed(Math.floor(days / DAYS_PER_MONTH)) };
	}
	return { unit: "year", value: signed(Math.floor(days / DAYS_PER_YEAR)) };
}

/**
 * `value` relative to `now` in `locale`: "5 minutes ago", "in 2 days",
 * "yesterday", "5分前". Anything under a minute reads as "now" with the
 * default `numeric: "auto"`. An invalid date returns an empty string.
 */
export function formatRelativeTime(
	locale: string | null | undefined,
	value: DateInput,
	options: RelativeTimeOptions = {}
): string {
	const seconds = elapsedSeconds(value, options.now);
	if (!Number.isFinite(seconds)) {
		return "";
	}
	const numeric = options.numeric ?? "auto";
	const formatter = relativeTimeFormatter(
		locale,
		options.style ?? "long",
		numeric
	);
	const parts = relativeTimeParts(seconds);
	if (parts.unit === "second" && numeric === "auto") {
		return formatter.format(0, "second");
	}
	return formatter.format(parts.value, parts.unit);
}

const COMPACT_UNITS = ["minute", "hour", "day", "week", "month", "year"];
const ENGLISH_COMPACT_SUFFIX: Record<RelativeTimeUnit, string> = {
	day: "d",
	hour: "h",
	minute: "m",
	month: "mo",
	second: "s",
	week: "w",
	year: "y",
};
/** A space between a number and a unit written in a script without spaces. */
const CJK_UNIT_GAP = /(\d)[\s  ]+(?=[぀-ヿ㐀-鿿])/gu;

/** English, or a tag `Intl` cannot read (which formats in English too). */
function isEnglish(locale: string | null | undefined): boolean {
	if (!locale || /^en(?:-|$)/iu.test(locale)) {
		return true;
	}
	try {
		return Intl.getCanonicalLocales(locale).length === 0;
	} catch {
		return true;
	}
}

/**
 * Narrow units, unless the locale's narrow forms collide (`5m` is both
 * minutes and months in Japanese): then the short forms, which never do.
 */
function compactUnitDisplay(locale: string): "narrow" | "short" {
	return compactUnitDisplays.get(locale, () => {
		const narrow = COMPACT_UNITS.map((unit) =>
			unitFormatter(locale, unit, "narrow").format(1)
		);
		return new Set(narrow).size === narrow.length ? "narrow" : "short";
	});
}

/**
 * A list badge's age: "now", "5m", "3h", "2d", "1w", "4mo", "1y" in English
 * (exactly the existing English output), and the locale's own unit
 * abbreviations elsewhere ("5分", "5 мин", "5 Min."). Future times read
 * as "now". An invalid date returns an empty string.
 */
export function formatCompactAge(
	locale: string | null | undefined,
	value: DateInput,
	options: CompactAgeOptions = {}
): string {
	const seconds = -elapsedSeconds(value, options.now);
	if (!Number.isFinite(seconds)) {
		return "";
	}
	const parts = relativeTimeParts(Math.max(0, seconds));
	if (isEnglish(locale)) {
		return parts.unit === "second"
			? "now"
			: `${parts.value}${ENGLISH_COMPACT_SUFFIX[parts.unit]}`;
	}
	const resolved = locale ?? DEFAULT_LOCALE;
	if (parts.unit === "second") {
		return relativeTimeFormatter(resolved, "narrow").format(0, "second");
	}
	return unitFormatter(resolved, parts.unit, compactUnitDisplay(resolved))
		.format(parts.value)
		.replace(CJK_UNIT_GAP, "$1");
}

/** Units a compact duration counts in. */
export type DurationUnit = "hour" | "minute" | "second" | "millisecond";

const ENGLISH_DURATION_SUFFIX: Record<DurationUnit, string> = {
	hour: "h",
	millisecond: "ms",
	minute: "m",
	second: "s",
};

/** CJK unit gap, Hangul included: durations read "1분" as well as "1分". */
const DURATION_UNIT_GAP =
	/(\d)[\s\u00a0\u202f]+(?=[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af])/gu;

/**
 * One compact duration unit: "12s", "1.5s", "420ms" in English (exactly the
 * hand-built English strings), and the locale's own short unit elsewhere
 * ("12秒", "12 Sek.", "١٢ ث"). Short, not narrow: narrow forms collide in
 * some locales (`5m` reads as both minutes and months in Japanese).
 */
export function formatDurationUnit(
	value: number,
	unit: DurationUnit,
	fractionDigits = 0,
	locale: string = activeLocale()
): string {
	if (isEnglish(locale)) {
		return `${value.toFixed(fractionDigits)}${ENGLISH_DURATION_SUFFIX[unit]}`;
	}
	return numberFormatter(locale, {
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits: fractionDigits,
		style: "unit",
		unit,
		unitDisplay: "short",
	})
		.format(value)
		.replace(DURATION_UNIT_GAP, "$1");
}

/**
 * Whole-number duration parts joined in order: `[[1, "minute"], [23,
 * "second"]]` reads "1m 23s" in English and "1分 23秒" in Japanese.
 */
export function formatDurationParts(
	parts: ReadonlyArray<readonly [number, DurationUnit]>,
	locale: string = activeLocale()
): string {
	return parts
		.map(([value, unit]) => formatDurationUnit(value, unit, 0, locale))
		.join(" ");
}

/** Byte units, smallest first, as `Intl` names them. */
export type ByteUnit =
	| "byte"
	| "kilobyte"
	| "megabyte"
	| "gigabyte"
	| "terabyte"
	| "petabyte";

const BYTE_UNITS: readonly ByteUnit[] = [
	"byte",
	"kilobyte",
	"megabyte",
	"gigabyte",
	"terabyte",
	"petabyte",
];
const ENGLISH_BYTE_UNIT: Record<ByteUnit, string> = {
	byte: "B",
	gigabyte: "GB",
	kilobyte: "KB",
	megabyte: "MB",
	petabyte: "PB",
	terabyte: "TB",
};

export interface ByteSizeOptions {
	/** 1024 (default, binary sizes as file managers show them) or 1000. */
	base?: 1000 | 1024;
	/** Fraction digits, or a rule picking them per scaled value; default 0 for bytes, 1 otherwise. */
	fractionDigits?: number | ((value: number, unit: ByteUnit) => number);
	/** Largest unit to scale up to (default `"petabyte"`). */
	maxUnit?: ByteUnit;
	/** Smallest unit to scale down to (default `"byte"`): `"kilobyte"` shows 512 B as "0.5 KB". */
	minUnit?: ByteUnit;
	/** A rate: "1.5 MB/s". */
	perSecond?: boolean;
	/** Drop trailing zeros: "2 MB", not "2.0 MB". */
	trimZeros?: boolean;
}

/**
 * A byte count as people read it: "512 B", "1.5 KB", "4.7 GB" in English
 * (`toFixed` digits and a space before an uppercase unit, exactly as the
 * hand-built English strings read), and the locale's own separators and unit
 * names elsewhere ("4,7 GB", "4,7 Go", "4.7 جيجابايت"). A non-finite count
 * reads as zero.
 */
export function formatByteSize(
	bytes: number,
	locale: string = activeLocale(),
	options: ByteSizeOptions = {}
): string {
	const count = Number.isFinite(bytes) ? bytes : 0;
	const base = options.base ?? 1024;
	const min = BYTE_UNITS.indexOf(options.minUnit ?? "byte");
	const max = Math.max(min, BYTE_UNITS.indexOf(options.maxUnit ?? "petabyte"));
	let index = min;
	while (index < max && Math.abs(count) >= base ** (index + 1)) {
		index += 1;
	}
	const unit = BYTE_UNITS[index] ?? "byte";
	const value = count / base ** index;
	const rule = options.fractionDigits;
	const digits = Math.min(
		20,
		Math.max(
			0,
			Math.trunc(
				typeof rule === "function"
					? rule(value, unit)
					: (rule ?? (unit === "byte" ? 0 : 1))
			)
		)
	);
	if (isEnglish(locale)) {
		const fixed = value.toFixed(digits);
		const number = options.trimZeros ? String(Number(fixed)) : fixed;
		return `${number} ${ENGLISH_BYTE_UNIT[unit]}${options.perSecond ? "/s" : ""}`;
	}
	return numberFormatter(locale, {
		maximumFractionDigits: digits,
		minimumFractionDigits: options.trimZeros ? 0 : digits,
		style: "unit",
		unit: options.perSecond ? `${unit}-per-second` : unit,
		unitDisplay: "short",
	}).format(value);
}

/** Billing periods {@link formatPerPeriod} writes. */
export type BillingPeriod = "month" | "year";

/**
 * An already formatted amount per billing period: "$12/mo" and "$120/yr" in
 * English, the UI language's own wording elsewhere (through the shared
 * `{price}/mo` and `{price}/yr` catalog messages the pricing tables use).
 */
export function formatPerPeriod(amount: string, period: BillingPeriod): string {
	return period === "year"
		? tl("{price}/yr", { price: amount })
		: tl("{price}/mo", { price: amount });
}

/** First day of the week, `Date#getDay()` style: 0 is Sunday, 1 Monday. */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The locale's first day of the week from Intl week data (`getWeekInfo()` in
 * current engines, the `weekInfo` getter in older ones): 1 for `de`, 6 for
 * `ar`, 0 for `en-US`. Undefined when the engine has no week data or the tag
 * is unusable, so callers keep their own default (date-fns' Sunday).
 */
export function weekStartForLocale(
	locale: string | null | undefined
): WeekStart | undefined {
	if (!locale) {
		return;
	}
	let weekInfo: unknown;
	try {
		const intlLocale = new Intl.Locale(locale);
		const getWeekInfo: unknown = Reflect.get(intlLocale, "getWeekInfo");
		weekInfo =
			typeof getWeekInfo === "function"
				? Reflect.apply(getWeekInfo, intlLocale, [])
				: Reflect.get(intlLocale, "weekInfo");
	} catch {
		return;
	}
	const firstDay: unknown =
		typeof weekInfo === "object" && weekInfo !== null
			? Reflect.get(weekInfo, "firstDay")
			: undefined;
	return typeof firstDay === "number" &&
		Number.isInteger(firstDay) &&
		firstDay >= 1 &&
		firstDay <= 7
		? ((firstDay % 7) as WeekStart)
		: undefined;
}
