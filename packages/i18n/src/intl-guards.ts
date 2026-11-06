// Degraded stand-ins for the `Intl` constructors some engines lack.
//
// Hermes (React Native) ships `Intl.DateTimeFormat`, `NumberFormat` and
// `Collator`, but `PluralRules`, `ListFormat` and `RelativeTimeFormat` can be
// missing. Calling a missing constructor throws during render, in every locale
// including English, so the formatters ask `hasIntl()` first and use these
// fallbacks instead: a small CLDR plural table, a plain list join, and (in
// `intl-relative-fallback.ts`) an English compact age through `translate()`.
// Hermes has no `Intl.Locale` either; `likely-script.ts` stands in for it.
// When the constructor exists it is always used, so behavior there is unchanged.

/** The `Intl` constructors this package may find missing. */
export type OptionalIntlConstructor =
	| "ListFormat"
	| "Locale"
	| "PluralRules"
	| "RelativeTimeFormat";

/** Whether this engine provides `Intl[name]` as a constructor. */
export function hasIntl(name: OptionalIntlConstructor): boolean {
	return (
		typeof Intl !== "undefined" && typeof Reflect.get(Intl, name) === "function"
	);
}

/** The one method the message formatter needs from `Intl.PluralRules`. */
export interface PluralSelector {
	select(count: number): Intl.LDMLPluralRule;
}

/** Locales whose cardinal plurals have only the `other` form. */
const OTHER_ONLY = new Set(["id", "ja", "ko", "ms", "th", "vi", "zh"]);
/** Locales where 0 and 1 (and 0 < n < 2) take `one`. */
const ONE_BELOW_TWO = new Set(["fr", "pt"]);
/** Slavic `one`/`few`/`many` rules (ru, uk, be share them). */
const EAST_SLAVIC = new Set(["be", "ru", "uk"]);

const FEW_LOW = 2;
const FEW_HIGH = 4;
const TEEN_LOW = 12;
const TEEN_HIGH = 14;
const TENS = 10;
const HUNDREDS = 100;

function language(locale: string | null | undefined): string {
	return (locale ?? "en").toLowerCase().split(/[-_]/u)[0] ?? "en";
}

function slavicCategory(count: number, polish: boolean): Intl.LDMLPluralRule {
	const lastDigit = count % TENS;
	const lastTwo = count % HUNDREDS;
	if (polish ? count === 1 : lastDigit === 1 && lastTwo !== 11) {
		return "one";
	}
	if (
		lastDigit >= FEW_LOW &&
		lastDigit <= FEW_HIGH &&
		(lastTwo < TEEN_LOW || lastTwo > TEEN_HIGH)
	) {
		return "few";
	}
	return "many";
}

function arabicCategory(count: number): Intl.LDMLPluralRule {
	const lastTwo = count % HUNDREDS;
	if (count === 0) {
		return "zero";
	}
	if (count === 1) {
		return "one";
	}
	if (count === 2) {
		return "two";
	}
	if (lastTwo >= 3 && lastTwo <= TENS) {
		return "few";
	}
	return lastTwo >= 11 ? "many" : "other";
}

/**
 * The CLDR cardinal category for `count` in `locale`, from a small table:
 * `other` only for ja/ko/zh and similar, one/few/many for ru/uk/pl, the six
 * Arabic forms, and one/other everywhere else. Fractions read as `other`
 * (`one` below 2 for fr/pt, below 1 for hi), as CLDR picks for most of them.
 */
export function fallbackPluralCategory(
	locale: string | null | undefined,
	count: number
): Intl.LDMLPluralRule {
	const lang = language(locale);
	const absolute = Math.abs(count);
	if (OTHER_ONLY.has(lang)) {
		return "other";
	}
	if (ONE_BELOW_TWO.has(lang)) {
		return absolute < 2 ? "one" : "other";
	}
	if (lang === "hi") {
		// CLDR hi: `i = 0 or n = 1`, so 0.5 and 1 are `one` but 1.5 is not.
		return absolute < 1 || absolute === 1 ? "one" : "other";
	}
	if (!Number.isInteger(absolute)) {
		return "other";
	}
	if (EAST_SLAVIC.has(lang) || lang === "pl") {
		return slavicCategory(absolute, lang === "pl");
	}
	if (lang === "ar") {
		return arabicCategory(absolute);
	}
	return absolute === 1 ? "one" : "other";
}

/** English ordinals ("1st", "2nd", "3rd", "4th"); `other` elsewhere. */
function fallbackOrdinalCategory(
	locale: string | null | undefined,
	count: number
): Intl.LDMLPluralRule {
	if (language(locale) !== "en" || !Number.isInteger(count)) {
		return "other";
	}
	const lastDigit = Math.abs(count) % TENS;
	const lastTwo = Math.abs(count) % HUNDREDS;
	if (lastTwo >= 11 && lastTwo <= 13) {
		return "other";
	}
	const byDigit: Partial<Record<number, Intl.LDMLPluralRule>> = {
		1: "one",
		2: "two",
		3: "few",
	};
	return byDigit[lastDigit] ?? "other";
}

/**
 * `new Intl.PluralRules(locale, { type })`, or the table above when the
 * engine has no `PluralRules`. An invalid tag still throws when it exists.
 */
export function pluralRules(
	locale: string,
	type: Intl.PluralRuleType
): PluralSelector {
	if (hasIntl("PluralRules")) {
		return new Intl.PluralRules(locale, { type });
	}
	return {
		select: (count) =>
			type === "ordinal"
				? fallbackOrdinalCategory(locale, count)
				: fallbackPluralCategory(locale, count),
	};
}

/** Scripts written without spaces join with the ideographic comma. */
const IDEOGRAPHIC_COMMA = new Set(["ja", "zh"]);

/** The `Intl.ListFormat` types `joinListFallback` understands. */
export type ListJoinType = "conjunction" | "disjunction" | "unit";

/** English's own list shape: "a and b", "a, b, and c", "a, b, or c". */
function joinEnglishList(items: readonly string[], type: ListJoinType): string {
	if (type === "unit" || items.length < 2) {
		return items.join(", ");
	}
	const word = type === "conjunction" ? "and" : "or";
	if (items.length === 2) {
		return `${items[0]} ${word} ${items[1]}`;
	}
	return `${items.slice(0, -1).join(", ")}, ${word} ${items.at(-1)}`;
}

/**
 * A list join for engines without `Intl.ListFormat`. English (and no locale)
 * keeps the exact `Intl` shape ("a, b, and c", "a or b"); other languages get
 * a plain "a, b, c", or "a、b、c" in Japanese and Chinese, with no final word.
 */
export function joinListFallback(
	items: readonly string[],
	locale: string | null | undefined,
	type: ListJoinType = "unit"
): string {
	const lang = language(locale);
	if (lang === "en") {
		return joinEnglishList(items, type);
	}
	return items.join(IDEOGRAPHIC_COMMA.has(lang) ? "、" : ", ");
}
