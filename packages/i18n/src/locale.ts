import { BUILT_IN_LANGUAGE_PACK_INFO } from "./built-in-pack-info.ts";
import { officialCatalogLocale } from "./catalog-locale.ts";
import { likelyLanguageAndScript } from "./likely-script.ts";
import {
	DEFAULT_LOCALE,
	type LanguageDirection,
	type LanguagePack,
} from "./pack.ts";

/** Most Accept-Language entries read; a longer header is truncated. */
const MAX_ACCEPT_LANGUAGE_ENTRIES = 32;

export function canonicalLocale(value: string, fallback: string): string {
	try {
		return Intl.getCanonicalLocales(value)[0] ?? fallback;
	} catch {
		return fallback;
	}
}

export function localeLanguageAndScript(locale: string): string {
	try {
		const maximized = new Intl.Locale(locale).maximize();
		return `${maximized.language.toLowerCase()}-${(maximized.script ?? "").toLowerCase()}`;
	} catch {
		// Hermes has no `Intl.Locale`: expand the script from Core's tables.
		return likelyLanguageAndScript(locale);
	}
}

export function directionForLocale(locale: string): LanguageDirection {
	return /^(ar|fa|he|ur|ps|dv)(?:-|$)/iu.test(locale) ? "rtl" : "ltr";
}

/**
 * The valid locales an HTTP Accept-Language header lists, canonical and best
 * first: `q=0` and `*` are dropped, equal weights keep the header's order and
 * malformed tags (`en_US`) are skipped.
 */
export function acceptLanguageLocales(header: string | null): string[] {
	if (!header) {
		return [];
	}
	const candidates = header
		.split(",")
		.slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES)
		.map((part, index) => {
			const [rawLocale, ...parameters] = part.trim().split(";");
			const quality = parameters.find((parameter) =>
				/^\s*q\s*=/iu.test(parameter)
			);
			const parsedQuality = quality ? Number(quality.split("=")[1]?.trim()) : 1;
			return {
				index,
				locale: rawLocale?.trim() ?? "",
				quality: Number.isFinite(parsedQuality) ? parsedQuality : 0,
			};
		})
		.filter((candidate) => candidate.quality > 0 && candidate.locale !== "*")
		.sort(
			(left, right) => right.quality - left.quality || left.index - right.index
		);
	const locales: string[] = [];
	for (const candidate of candidates) {
		const canonical = canonicalLocale(candidate.locale, "");
		if (canonical && !locales.includes(canonical)) {
			locales.push(canonical);
		}
	}
	return locales;
}

/** Whether `locale` is English, the source catalog every surface renders. */
export function isEnglishLocale(locale: string): boolean {
	return (
		localeLanguageAndScript(locale) === localeLanguageAndScript(DEFAULT_LOCALE)
	);
}

/** A pack list holds only `enabled` and `locale` for this question. */
type LocalePack = Pick<LanguagePack, "enabled" | "locale">;

/**
 * The first of `locales` (best first) that Ryu can show: English, a
 * first-party voice, an official literal catalog, or one of `packs` (for
 * example installed community packs). Null when none can be shown. A list
 * such as `nl-NL, de` answers `de`, where only its first entry would fall
 * back to English.
 */
export function preferredOfficialLocale(
	locales: readonly string[],
	packs: readonly LocalePack[] = []
): string | null {
	for (const locale of locales) {
		const canonical = canonicalLocale(locale, "");
		if (
			canonical &&
			(isEnglishLocale(canonical) ||
				officialCatalogLocale(canonical) !== null ||
				findLanguagePackForLocale(BUILT_IN_LANGUAGE_PACK_INFO, canonical) ||
				findLanguagePackForLocale(packs, canonical))
		) {
			return canonical;
		}
	}
	return null;
}

/**
 * The locale to answer an HTTP Accept-Language header in: the best-weighted
 * tag Ryu can show (see {@link preferredOfficialLocale}), else the
 * best-weighted valid tag (so formatting still follows it), else English.
 */
export function localeFromAcceptLanguage(
	header: string | null,
	packs: readonly LocalePack[] = []
): string {
	const locales = acceptLanguageLocales(header);
	return (
		preferredOfficialLocale(locales, packs) ?? locales[0] ?? DEFAULT_LOCALE
	);
}

/**
 * The browser's or OS's preferred languages, best first:
 * `navigator.languages`, else `navigator.language`, else none (on the
 * server). Hand the list to a provider's `initialLocale` in auto mode.
 */
export function systemLocales(): string[] {
	const nav = (
		globalThis as {
			navigator?: { language?: string; languages?: readonly string[] };
		}
	).navigator;
	const languages = (nav?.languages ?? []).filter(
		(language) => typeof language === "string" && language.length > 0
	);
	if (languages.length > 0) {
		return [...languages];
	}
	return nav?.language ? [nav.language] : [];
}

/**
 * The pack a locale auto-selects: an enabled exact locale match first, then
 * the first enabled pack with the same language and script. English is the
 * source catalog, so `en`/`en-*` never auto-selects a voice; users can still
 * choose one explicitly. Pack metadata without messages is enough to answer.
 */
export function findLanguagePackForLocale<
	Pack extends Pick<LanguagePack, "enabled" | "locale">,
>(packs: readonly Pack[], locale: string): Pack | null {
	const canonical = canonicalLocale(locale, DEFAULT_LOCALE);
	const languageAndScript = localeLanguageAndScript(canonical);
	if (languageAndScript === localeLanguageAndScript(DEFAULT_LOCALE)) {
		return null;
	}
	const exact = packs.find(
		(pack) => pack.enabled !== false && pack.locale === canonical
	);
	if (exact) {
		return exact;
	}
	return (
		packs.find(
			(pack) =>
				pack.enabled !== false &&
				localeLanguageAndScript(pack.locale) === languageAndScript
		) ?? null
	);
}
