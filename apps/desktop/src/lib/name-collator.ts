// Name sorting in the language the UI shows.
//
// `a.localeCompare(b)` without a locale follows the OS/webview locale, not the
// Ryu language the user picked, and compares digit runs character by
// character: a Chinese UI on an English OS put 张三 before 阿明 (code-point
// order instead of pinyin), and every UI put "Notiz 10" before "Notiz 2".
// `compareNames` reads `activeLocale()` and reuses one numeric collator per
// locale, so every name sort shares the same order.

import { activeLocale } from "@ryu/i18n/core";

const collators = new Map<string, Intl.Collator>();

function collatorFor(locale: string): Intl.Collator {
	const cached = collators.get(locale);
	if (cached) {
		return cached;
	}
	let collator: Intl.Collator;
	try {
		collator = new Intl.Collator(locale, { numeric: true });
	} catch {
		// An unusable tag (malformed or unsupported) still sorts, in English.
		collator = new Intl.Collator("en", { numeric: true });
	}
	collators.set(locale, collator);
	return collator;
}

/** Compares two display names: pinyin/kana/alphabet order of the UI language,
 *  with numbers by value ("Notiz 2" before "Notiz 10"). */
export function compareNames(
	a: string,
	b: string,
	locale: string = activeLocale()
): number {
	return collatorFor(locale).compare(a, b);
}
