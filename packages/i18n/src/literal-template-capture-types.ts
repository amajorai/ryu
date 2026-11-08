// What a literal-template capture must look like for its placeholder.
//
// The DOM localizer and host relays match untranslated English text against
// catalog templates. A placeholder used as a count (`{count} pull requests`)
// or a time (`Signed in {relativeTime}`, `{title} failed at {time}`) only
// accepts a capture that reads as one: an English verb or phrase that happens
// to sit where the number goes (`List pull requests`, `Signed in as a@b.com`,
// `Sync failed at startup`) is data, and stays as written instead of coming
// out as `プルリクエスト List 件`.
//
// A placeholder is numeric when its name is a count (`count`, `n`, `total`,
// `…Count`, `…Total`) or the translation formats it as a plural, ordinal or
// number; temporal when its name is a time (`time`, `date`, `relativeTime`,
// `when`, `…At`, `…Date`, `…Time`, `…Ago`) or the translation formats it as
// a date or time. Every other placeholder is free and keeps the shape-only
// checks in `literal-template-parse.ts`.

import { isIdentifierArgument } from "./literal-template-numerals.ts";

export type CaptureType = "free" | "numeric" | "temporal";

/** Any digit, in any script (`3`, `٣`, `३`). */
const NUMERAL = /\p{N}/u;
const NUMERIC_NAMES = new Set(["count", "n", "num", "total"]);
const NUMERIC_SUFFIXES = ["Count", "Total"];
const TEMPORAL_NAMES = new Set([
	"ago",
	"at",
	"date",
	"datetime",
	"relativetime",
	"time",
	"timestamp",
	"when",
]);
const TEMPORAL_SUFFIXES = ["Ago", "At", "Date", "DateTime", "Time"];
/** ICU argument types a translation formats as a number or a time. */
const NUMERIC_FORMATS = new Set(["number", "plural", "selectordinal"]);
const TEMPORAL_FORMATS = new Set(["date", "time"]);
/** Relative-time phrasing that `Intl` does not spell out on its own
 * (`just now`, `a few seconds ago`, `less than a minute ago`). */
const EXTRA_TEMPORAL_WORDS = [
	"a",
	"about",
	"almost",
	"an",
	"few",
	"just",
	"less",
	"midnight",
	"moment",
	"moments",
	"never",
	"noon",
	"on",
	"over",
	"than",
	"tonight",
];
const RELATIVE_UNITS = [
	"second",
	"minute",
	"hour",
	"day",
	"week",
	"month",
	"quarter",
	"year",
] as const;
/** The shipped locales: a time the app already formatted in the viewer's
 * language (`Signed in gestern`) still reads as a time. */
const TIME_WORD_LOCALES = [
	"en",
	"ar",
	"de",
	"es",
	"fr",
	"hi",
	"it",
	"ja",
	"ko",
	"pt",
	"ru",
	"zh",
];
const WORD_EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

let temporalWords: Set<string> | null = null;

function addWords(words: Set<string>, text: string): void {
	for (const word of text.toLowerCase().split(/\s+/u)) {
		const bare = word.replace(WORD_EDGE_PUNCTUATION, "");
		if (bare && !NUMERAL.test(bare)) {
			words.add(bare);
		}
	}
}

function addLocaleWords(words: Set<string>, locale: string): void {
	const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	for (const unit of RELATIVE_UNITS) {
		for (const amount of [-2, -1, 0, 1, 2]) {
			addWords(words, relative.format(amount, unit));
		}
	}
	// Short names only for English: abbreviations elsewhere collide with
	// English words (Italian `set` for settembre).
	const options: readonly ("long" | "short")[] =
		locale === "en" ? ["long", "short"] : ["long"];
	for (const option of options) {
		const weekday = new Intl.DateTimeFormat(locale, { weekday: option });
		const month = new Intl.DateTimeFormat(locale, { month: option });
		for (let day = 0; day < 12; day += 1) {
			const date = new Date(Date.UTC(2024, day, 1 + day));
			addWords(words, weekday.format(date));
			addWords(words, month.format(date));
		}
	}
}

/** Words a relative or absolute time is written with, taken from `Intl`
 * (`yesterday`, `ago`, `next week`, `Monday`, `March`, `gestern`). */
function knownTemporalWords(): Set<string> {
	if (temporalWords) {
		return temporalWords;
	}
	const words = new Set(EXTRA_TEMPORAL_WORDS);
	for (const locale of TIME_WORD_LOCALES) {
		try {
			addLocaleWords(words, locale);
		} catch {
			// Without Intl only the fixed words above count as times.
		}
	}
	temporalWords = words;
	return words;
}

function hasSuffix(name: string, suffixes: readonly string[]): boolean {
	return suffixes.some(
		(suffix) => name.length > suffix.length && name.endsWith(suffix)
	);
}

/** The ICU types `translation` gives argument `name` (`{count, plural, …}`). */
function argumentFormats(translation: string, name: string): Set<string> {
	const formats = new Set<string>();
	let open = translation.indexOf("{");
	while (open >= 0) {
		const head = /^\{\s*([^\s,{}]+)\s*,\s*([a-z]+)/u.exec(
			translation.slice(open)
		);
		if (head?.[1] === name && head[2]) {
			formats.add(head[2]);
		}
		open = translation.indexOf("{", open + 1);
	}
	return formats;
}

/** Whether `name` (in `translation`) holds a count, a time, or anything. */
export function captureType(name: string, translation = ""): CaptureType {
	const formats = argumentFormats(translation, name);
	if ([...formats].some((format) => TEMPORAL_FORMATS.has(format))) {
		return "temporal";
	}
	if ([...formats].some((format) => NUMERIC_FORMATS.has(format))) {
		return "numeric";
	}
	if (isIdentifierArgument(name)) {
		return "free";
	}
	const lower = name.toLowerCase();
	if (NUMERIC_NAMES.has(lower) || hasSuffix(name, NUMERIC_SUFFIXES)) {
		return "numeric";
	}
	if (TEMPORAL_NAMES.has(lower) || hasSuffix(name, TEMPORAL_SUFFIXES)) {
		return "temporal";
	}
	return "free";
}

/** Whether `value` reads as a time: it has a digit, or every word is a
 * relative or calendar word (`yesterday`, `just now`, `last Monday`,
 * `gestern`). */
export function looksTemporal(value: string): boolean {
	if (NUMERAL.test(value)) {
		return true;
	}
	const words = value
		.toLowerCase()
		.split(/\s+/u)
		.map((word) => word.replace(WORD_EDGE_PUNCTUATION, ""))
		.filter(Boolean);
	const known = knownTemporalWords();
	return words.length > 0 && words.every((word) => known.has(word));
}

/**
 * Whether every captured value fits its placeholder's type: a count holds a
 * numeral, a time holds a numeral or time words, and a free value anything.
 */
export function capturesFitTypes(
	values: Record<string, string>,
	translation = ""
): boolean {
	for (const [name, value] of Object.entries(values)) {
		const type = captureType(name, translation);
		if (type === "numeric" && !NUMERAL.test(value)) {
			return false;
		}
		if (type === "temporal" && !looksTemporal(value)) {
			return false;
		}
	}
	return true;
}
