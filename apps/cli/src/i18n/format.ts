// Dates and numbers in the CLI's locale (see `cliLocales`). Bare
// `toLocaleString()` would follow the runtime's default instead, which ignores
// RYU_LOCALE and LANGUAGE.

import { type ByteSizeOptions, formatByteSize } from "@ryu/i18n/format-intl";
import { CLI_FORMAT_LOCALE } from "./translate.ts";

type DateInput = Date | number | string;

function toDate(value: DateInput): Date | null {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}

/** A date and time (`31 Oct 2026, 14:05`); invalid input returns null. */
export function formatCliDateTime(
	value: DateInput,
	locale: string = CLI_FORMAT_LOCALE
): string | null {
	const date = toDate(value);
	return date
		? new Intl.DateTimeFormat(locale, {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(date)
		: null;
}

/** A calendar date (`31 Oct 2026`); invalid input returns null. */
export function formatCliDate(
	value: DateInput,
	locale: string = CLI_FORMAT_LOCALE
): string | null {
	const date = toDate(value);
	return date
		? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date)
		: null;
}

/** A short count with the locale's compact notation (`1.2K`, `2,5 Mio.`). */
export function formatCliCompact(
	value: number,
	locale: string = CLI_FORMAT_LOCALE
): string {
	return new Intl.NumberFormat(locale, {
		maximumFractionDigits: 1,
		notation: "compact",
	}).format(value);
}

/** A number with the locale's grouping and decimal separators. */
export function formatCliNumber(
	value: number,
	options?: Intl.NumberFormatOptions,
	locale: string = CLI_FORMAT_LOCALE
): string {
	return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * A byte count with the locale's separators and unit names (`1.5 GB`,
 * `1,5 GB`, `1,5 Go`); see `formatByteSize` for the options.
 */
export function formatCliBytes(
	bytes: number,
	options?: ByteSizeOptions,
	locale: string = CLI_FORMAT_LOCALE
): string {
	return formatByteSize(bytes, locale, options);
}

function narrowUnit(
	value: number,
	unit: "millisecond" | "minute" | "second",
	locale: string,
	fractionDigits = 0,
	minimumFractionDigits = fractionDigits
): string {
	return new Intl.NumberFormat(locale, {
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits,
		style: "unit",
		unit,
		unitDisplay: "narrow",
	}).format(value);
}

interface DurationFormatter {
	format(duration: { minutes: number; seconds: number }): string;
}
type DurationFormatConstructor = new (
	locale: string,
	options: { secondsDisplay: "always" | "auto"; style: "narrow" }
) => DurationFormatter;

function minutesAndSeconds(
	minutes: number,
	seconds: number,
	locale: string,
	omitZeroSeconds = false
): string {
	// `Intl.DurationFormat` is newer than the `Intl` typings the CLI builds with.
	const DurationFormat = (
		Intl as unknown as { DurationFormat?: DurationFormatConstructor }
	).DurationFormat;
	if (typeof DurationFormat === "function") {
		return new DurationFormat(locale, {
			secondsDisplay: omitZeroSeconds ? "auto" : "always",
			style: "narrow",
		}).format({
			minutes,
			seconds,
		});
	}
	const minutePart = narrowUnit(minutes, "minute", locale);
	if (omitZeroSeconds && seconds === 0) {
		return minutePart;
	}
	return `${minutePart} ${narrowUnit(seconds, "second", locale)}`;
}

/**
 * A compact elapsed time: `4.2s` below a minute, then `1m 5s`. With
 * `milliseconds`, sub-100ms spans read `42ms`. With `trimZeros`, whole
 * seconds drop the `.0` (`12s`) and whole minutes drop the seconds (`2m`).
 */
export function formatCliElapsed(
	ms: number,
	options: { milliseconds?: boolean; trimZeros?: boolean } = {},
	locale: string = CLI_FORMAT_LOCALE
): string {
	const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	if (options.milliseconds && safe < 100) {
		return narrowUnit(Math.round(safe), "millisecond", locale);
	}
	const seconds = safe / 1000;
	if (seconds < 59.95) {
		return narrowUnit(seconds, "second", locale, 1, options.trimZeros ? 0 : 1);
	}
	const whole = Math.round(seconds);
	return minutesAndSeconds(
		Math.floor(whole / 60),
		whole % 60,
		locale,
		options.trimZeros
	);
}
