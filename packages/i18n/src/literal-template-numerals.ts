// Numbers captured by a literal template, formatted for the reader.
//
// A dynamic sentence (`Expected 12.50 seconds; received 3.00 seconds.`) is
// built in English with `toFixed`, so its numerals carry an English decimal
// point and no digit grouping. When a catalog template matches it, the
// captured values are inserted into the translation as data; this module
// reformats the plain decimal ones in the reader's locale (`12,50` in German,
// native digits where the locale's numbering system uses them), keeping the
// number of decimals the sentence was written with.
//
// Values that only look numeric are left alone: a `…Label` argument, an
// identifier-like argument (`{id}`, `{year}`, `{port}`, `{issueNumber}`, …),
// a zero-padded value (`007`), a value too long to round-trip through a
// double, and a small integer (under 10,000), which reads the same in most
// locales and is most often a count or a code. An argument the translation
// formats itself (`{count, plural, …}`, `{size, number}`) keeps its raw value:
// the message formatter parses it as a number. A value already grouped in the
// reader's locale (`32.768` in German) is kept as written.

import { numberFormatter } from "./format-intl.ts";
import { isLocaleGroupedInteger } from "./literal-template-numerals-grouping.ts";

/** An optionally signed decimal written with ASCII digits and a `.`. */
const PLAIN_DECIMAL = /^-?(\d+)(?:\.(\d+))?$/u;
/** Integers below this stay as written (`{count}`, `{step}`, `{total}`). */
export const MIN_GROUPED_INTEGER = 10_000;
/** Longest integer part that survives `Number()` exactly. */
const MAX_INTEGER_DIGITS = 15;
/** Most decimals reformatted; longer fractions are raw output. */
const MAX_FRACTION_DIGITS = 6;
/** Suffix of a catalog-label argument (`{titleLabel}`). */
const LABEL_SUFFIX = "Label";
/** Argument names whose value is an identifier, not a quantity. */
const IDENTIFIER_NAMES = new Set([
	"code",
	"id",
	"index",
	"number",
	"pid",
	"port",
	"status",
	"version",
	"year",
]);
/** The same names as a camel-case suffix (`issueId`, `exitCode`). */
const IDENTIFIER_SUFFIXES = [...IDENTIFIER_NAMES].map(
	(name) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`
);

/** Whether `translation` uses `name` as a typed argument (`{name, plural, …}`). */
function isTypedArgument(translation: string, name: string): boolean {
	let open = translation.indexOf("{");
	while (open >= 0) {
		const head = /^\{\s*([^\s,{}]+)\s*,/u.exec(translation.slice(open));
		if (head?.[1] === name) {
			return true;
		}
		open = translation.indexOf("{", open + 1);
	}
	return false;
}

/** Whether the argument `name` holds an identifier or a label. */
export function isIdentifierArgument(name: string): boolean {
	const lower = name.toLowerCase();
	if (IDENTIFIER_NAMES.has(lower) || lower.startsWith("revision")) {
		return true;
	}
	if (name.length > LABEL_SUFFIX.length && name.endsWith(LABEL_SUFFIX)) {
		return true;
	}
	return IDENTIFIER_SUFFIXES.some(
		(suffix) => name.length > suffix.length && name.endsWith(suffix)
	);
}

/**
 * `value` captured for argument `name`, reformatted for `locale` when it is a
 * plain decimal quantity that `translation` inserts as text; otherwise `value`
 * unchanged.
 */
export function formatCapturedNumeral(
	name: string,
	value: string,
	locale: string,
	translation: string
): string {
	const parsed = PLAIN_DECIMAL.exec(value);
	if (
		!parsed ||
		isIdentifierArgument(name) ||
		isTypedArgument(translation, name) ||
		isLocaleGroupedInteger(value, locale, name)
	) {
		return value;
	}
	const [, integer = "", fraction = ""] = parsed;
	if (
		integer.length > MAX_INTEGER_DIGITS ||
		fraction.length > MAX_FRACTION_DIGITS ||
		(integer.length > 1 && integer.startsWith("0"))
	) {
		return value;
	}
	const amount = Number(value);
	if (
		!Number.isFinite(amount) ||
		(fraction === "" && Math.abs(amount) < MIN_GROUPED_INTEGER)
	) {
		return value;
	}
	try {
		return numberFormatter(locale, {
			maximumFractionDigits: fraction.length,
			minimumFractionDigits: fraction.length,
		}).format(amount);
	} catch {
		return value;
	}
}
