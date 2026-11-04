import { activeLocale } from "./active-locale.ts";
import { numberFormatter } from "./format-intl.ts";

// Read a number the user typed in their own locale: "12,50" in German,
// "1 234,5" in French, "1,000.5" in English. Money inputs depend on this, so
// the parser prefers NaN to a guess: an input it cannot read one way only is
// refused, never truncated the way `parseFloat("12,50")` truncates to 12.
//
// Rules, for a locale with decimal separator D and group separator G:
// - A comma-decimal locale also accepts "." as the decimal, unless "." is
//   that locale's group separator and exactly three digits follow ("1.000"
//   in German is one thousand; "7.5" is seven and a half).
// - The locale's own decimal separator always means the decimal ("1,000" in
//   German is one; "1.000" in English is one).
// - With two different separators, the last one (used once) is the decimal
//   and the others are groups ("1.000,5" and "1,000.5" both read 1000.5).
// - Groups must look like groups: 1–3 leading digits, then runs of 2 or 3
//   (Indian grouping), ending in a run of 3.
// - Native digits (Arabic-Indic, Devanagari, Bengali, full-width…), the
//   Arabic decimal and group marks, and full-width "," and "." are accepted.

const DIGIT_ZEROS = [
	0x6_60, 0x6_f0, 0x9_66, 0x9_e6, 0xa_66, 0xa_e6, 0xb_66, 0xb_e6, 0xc_66,
	0xc_e6, 0xd_66, 0xe_50, 0xe_d0, 0xf_20, 0x10_40, 0x17_e0, 0x18_10, 0xff_10,
];
const SPACE_GROUPS = new Set([" ", " ", " ", " "]);
const APOSTROPHE_GROUPS = new Set(["'", "’", "ʼ"]);
const ARABIC_DECIMAL = "٫";
const ARABIC_GROUP = "٬";
const SIGNS = new Set(["-", "+", "−"]);
const DIGITS_ONLY = /^\d*$/u;
const LEADING_GROUP = /^[1-9]\d{0,2}$/u;
const MIDDLE_GROUP = /^\d{2,3}$/u;
const LAST_GROUP = /^\d{3}$/u;

export interface LocaleSeparators {
	decimal: string;
	group: string;
}

/** The decimal and group separators `locale` formats numbers with. */
export function localeSeparators(
	locale: string | null | undefined = activeLocale()
): LocaleSeparators {
	let decimal = ".";
	let group = ",";
	for (const part of numberFormatter(locale).formatToParts(1_234_567.5)) {
		if (part.type === "decimal") {
			decimal = part.value;
		} else if (part.type === "group") {
			group = part.value;
		}
	}
	return { decimal: canonicalChar(decimal), group: canonicalChar(group) };
}

/** Fold look-alike separators and native digits onto one ASCII form. */
function canonicalChar(char: string): string {
	if (SPACE_GROUPS.has(char)) {
		return " ";
	}
	if (APOSTROPHE_GROUPS.has(char)) {
		return "'";
	}
	if (char === "，") {
		return ",";
	}
	if (char === "．") {
		return ".";
	}
	const code = char.codePointAt(0) ?? 0;
	for (const zero of DIGIT_ZEROS) {
		if (code >= zero && code <= zero + 9) {
			return String(code - zero);
		}
	}
	return char;
}

function validGroups(integer: string, group: string): boolean {
	const chunks = integer.split(group);
	const last = chunks.length - 1;
	return chunks.every((chunk, index) => {
		if (index === 0) {
			return LEADING_GROUP.test(chunk);
		}
		return index === last ? LAST_GROUP.test(chunk) : MIDDLE_GROUP.test(chunk);
	});
}

function toNumber(sign: string, integer: string, fraction: string): number {
	if (!(integer || fraction)) {
		return Number.NaN;
	}
	if (!(DIGITS_ONLY.test(integer) && DIGITS_ONLY.test(fraction))) {
		return Number.NaN;
	}
	const value = Number(`${integer || "0"}.${fraction || "0"}`);
	return sign === "-" ? -value : value;
}

/**
 * Parse `text` as a number written in `locale` (the active UI locale by
 * default). Returns NaN for empty, malformed or ambiguous input; callers
 * still apply their own range checks.
 */
export function parseLocaleNumber(
	text: string,
	locale: string | null | undefined = activeLocale()
): number {
	const { decimal, group } = localeSeparators(locale);
	const chars = Array.from(text.trim(), canonicalChar);
	let sign = "";
	if (chars.length > 0 && SIGNS.has(chars[0] ?? "")) {
		sign = chars.shift() === "+" ? "" : "-";
	}
	const body = chars.join("");
	const canDecimal = (char: string) =>
		char === decimal || char === "." || char === ARABIC_DECIMAL;
	const canGroup = (char: string) =>
		char === group ||
		char === "." ||
		char === "," ||
		char === ARABIC_GROUP ||
		(char === " " && group === " ") ||
		(char === "'" && group === "'");
	const separators = body.replace(/\d/gu, "");
	if (!separators) {
		return toNumber(sign, body, "");
	}
	const distinct = [...new Set(separators)];
	if (distinct.length > 2) {
		return Number.NaN;
	}
	const lastSeparator = separators.at(-1) ?? "";
	const lastIndex = body.lastIndexOf(lastSeparator);
	const head = body.slice(0, lastIndex);
	const tail = body.slice(lastIndex + 1);

	if (distinct.length === 2) {
		// "1.000,5": the last separator is the decimal, the rest are groups.
		const groupChar = distinct.find((char) => char !== lastSeparator) ?? "";
		const usedOnce =
			separators.indexOf(lastSeparator) === separators.length - 1;
		if (!(usedOnce && canDecimal(lastSeparator) && canGroup(groupChar))) {
			return Number.NaN;
		}
		return validGroups(head, groupChar)
			? toNumber(sign, head.split(groupChar).join(""), tail)
			: Number.NaN;
	}

	const only = lastSeparator;
	if (separators.length > 1) {
		// "1.000.000": a repeated separator can only group.
		return canGroup(only) && validGroups(body, only)
			? toNumber(sign, body.split(only).join(""), "")
			: Number.NaN;
	}
	const readsAsGroup =
		only !== decimal &&
		canGroup(only) &&
		(!canDecimal(only) || (only === group && LAST_GROUP.test(tail)));
	if (readsAsGroup) {
		return validGroups(body, only)
			? toNumber(sign, `${head}${tail}`, "")
			: Number.NaN;
	}
	return canDecimal(only) ? toNumber(sign, head, tail) : Number.NaN;
}

/**
 * Format `value` the way a user would type it in `locale` (no grouping), for
 * pre-filling an editable number input that `parseLocaleNumber` reads back.
 */
export function formatLocaleNumberInput(
	value: number,
	locale: string | null | undefined = activeLocale(),
	maximumFractionDigits = 2
): string {
	return numberFormatter(locale, {
		maximumFractionDigits,
		useGrouping: false,
	}).format(value);
}
