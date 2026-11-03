import { officialCatalogLocale } from "./catalog-locale.ts";
import {
	type LiteralCatalog,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";

type CatalogModule = Promise<{ default: LiteralCatalog }>;

/**
 * The `web` subset of the official literal catalogs: the website's own copy,
 * the shared design-system packages it renders, control-plane refusals and
 * the store listings its app and plugin store shows, not every surface's
 * strings. One lazy chunk per official locale; keep the specifiers literal
 * so the bundler can split each into its own chunk. Rebuild with
 * `bun tools/i18n-catalog.mjs build`.
 */
const OFFICIAL_WEB_CATALOGS: Readonly<Record<string, () => CatalogModule>> = {
	ar: () => import("../locales/web/ar.json"),
	de: () => import("../locales/web/de.json"),
	es: () => import("../locales/web/es.json"),
	fr: () => import("../locales/web/fr.json"),
	hi: () => import("../locales/web/hi.json"),
	it: () => import("../locales/web/it.json"),
	ja: () => import("../locales/web/ja.json"),
	ko: () => import("../locales/web/ko.json"),
	"pt-BR": () => import("../locales/web/pt-BR.json"),
	ru: () => import("../locales/web/ru.json"),
	"zh-CN": () => import("../locales/web/zh-CN.json"),
};

/** Load the website's `web` catalog for `locale`, or null when none ships. */
export async function loadOfficialWebLiteralCatalog(
	locale: string
): Promise<LiteralCatalog | null> {
	const official = officialCatalogLocale(locale);
	const load = official ? OFFICIAL_WEB_CATALOGS[official] : undefined;
	if (!load) {
		return null;
	}
	return (await load()).default;
}

// Importing this module is the opt-in: every runtime on the page now resolves
// extracted UI literals from the web subset for the selected locale.
registerLiteralCatalogLoader(loadOfficialWebLiteralCatalog);
