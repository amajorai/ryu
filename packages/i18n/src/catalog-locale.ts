/** Locales with an official literal catalog in `packages/i18n/locales/`. */
export const OFFICIAL_CATALOG_LOCALES: readonly string[] = [
	"ar",
	"de",
	"es",
	"fr",
	"hi",
	"it",
	"ja",
	"ko",
	"pt-BR",
	"ru",
	"zh-CN",
];

/** Official locale whose language and script match `locale` (pt-PT → pt-BR, zh-TW → none). */
export function officialCatalogLocale(locale: string): string | null {
	if (OFFICIAL_CATALOG_LOCALES.includes(locale)) {
		return locale;
	}
	try {
		const wanted = new Intl.Locale(locale).maximize();
		for (const candidate of OFFICIAL_CATALOG_LOCALES) {
			const official = new Intl.Locale(candidate).maximize();
			if (
				official.language === wanted.language &&
				official.script === wanted.script
			) {
				return candidate;
			}
		}
	} catch {
		// An invalid tag has no official catalog.
	}
	return null;
}
