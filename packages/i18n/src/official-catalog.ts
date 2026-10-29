import { officialCatalogLocale } from "./catalog-locale.ts";
import {
	type LiteralCatalog,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";

type CatalogModule = Promise<{ default: LiteralCatalog }>;

/**
 * One lazy chunk per official locale. Keep the specifiers literal: bundlers
 * (Vite, Next, WXT, Metro) split each catalog into its own chunk only when
 * they can see the path, so a session downloads just the selected language.
 */
const OFFICIAL_LITERAL_CATALOGS: Readonly<Record<string, () => CatalogModule>> =
	{
		ar: () => import("../locales/ar.json"),
		de: () => import("../locales/de.json"),
		es: () => import("../locales/es.json"),
		fr: () => import("../locales/fr.json"),
		hi: () => import("../locales/hi.json"),
		it: () => import("../locales/it.json"),
		ja: () => import("../locales/ja.json"),
		ko: () => import("../locales/ko.json"),
		"pt-BR": () => import("../locales/pt-BR.json"),
		ru: () => import("../locales/ru.json"),
		"zh-CN": () => import("../locales/zh-CN.json"),
	};

/** Load the official literal catalog for `locale`, or null when none ships. */
export async function loadOfficialLiteralCatalog(
	locale: string
): Promise<LiteralCatalog | null> {
	const official = officialCatalogLocale(locale);
	const load = official ? OFFICIAL_LITERAL_CATALOGS[official] : undefined;
	if (!load) {
		return null;
	}
	return (await load()).default;
}

// Importing this module is the opt-in: every runtime on the page now resolves
// extracted UI literals for the selected locale.
registerLiteralCatalogLoader(loadOfficialLiteralCatalog);
