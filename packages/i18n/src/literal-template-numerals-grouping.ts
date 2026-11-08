// Whether a captured numeral is already grouped in the reader's locale.
//
// English sources write decimals with `.`, and so do locales such as German,
// Spanish, Italian and Brazilian Portuguese when they group thousands
// (`32.768` is 32,768 there). A literal `${formatCount(n)} tokens` reaches
// the template matcher already formatted for the reader, so a value with one
// to three integer digits followed by exactly three digit groups is
// ambiguous. The reader's locale decides: when it groups with `.`, the value
// is read as a grouped integer and kept as written, never re-read as an
// English decimal (which would show `32,768`, a number 1,000 times smaller).
//
// Two shapes stay decimals because a grouped integer never takes them: a
// leading `0` (`0.250`), and a percentage argument (`{percent}`,
// `{driftPercent}`, `{pct}`), whose `toFixed(3)` value is never a count in
// the thousands.

import { numberFormatter } from "./format-intl.ts";

/** One to three leading digits (no leading zero), then `.` groups of three. */
const DOT_GROUPED_INTEGER = /^-?[1-9]\d{0,2}(?:\.\d{3})+$/u;
/** Argument names that hold a percentage, matched case-insensitively. */
const PERCENT_NAME = /(?:percent|pct)$/iu;
/** A value large enough that every grouping locale groups it. */
const GROUPING_PROBE = 11_111;

const groupSeparators = new Map<string, string>();

/** The digit-group separator `locale` uses, or `""` when it has none. */
export function localeGroupSeparator(locale: string): string {
	const cached = groupSeparators.get(locale);
	if (cached !== undefined) {
		return cached;
	}
	let separator = "";
	try {
		separator =
			numberFormatter(locale)
				.formatToParts(GROUPING_PROBE)
				.find((part) => part.type === "group")?.value ?? "";
	} catch {
		separator = "";
	}
	groupSeparators.set(locale, separator);
	return separator;
}

/**
 * Whether `raw`, captured for argument `name`, reads as an integer grouped
 * with `.` in `locale` (`32.768` in German), so it must not be reformatted as
 * an English decimal.
 */
export function isLocaleGroupedInteger(
	raw: string,
	locale: string,
	name = ""
): boolean {
	return (
		DOT_GROUPED_INTEGER.test(raw) &&
		!PERCENT_NAME.test(name) &&
		localeGroupSeparator(locale) === "."
	);
}
