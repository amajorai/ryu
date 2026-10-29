import {
	DEFAULT_LOCALE,
	type LanguageDirection,
	type LanguagePack,
} from "./pack.ts";

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
		return `${locale.split("-")[0]?.toLowerCase() ?? locale.toLowerCase()}-`;
	}
}

export function directionForLocale(locale: string): LanguageDirection {
	return /^(ar|fa|he|ur|ps|dv)(?:-|$)/iu.test(locale) ? "rtl" : "ltr";
}

/** Resolve the highest-priority valid locale from an HTTP Accept-Language header. */
export function localeFromAcceptLanguage(header: string | null): string {
	if (!header) {
		return DEFAULT_LOCALE;
	}
	const candidates = header
		.split(",")
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
	for (const candidate of candidates) {
		const canonical = canonicalLocale(candidate.locale, "");
		if (canonical) {
			return canonical;
		}
	}
	return DEFAULT_LOCALE;
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
