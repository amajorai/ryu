import arCatalog from "../locales/cli/ar.json";
import deCatalog from "../locales/cli/de.json";
import esCatalog from "../locales/cli/es.json";
import frCatalog from "../locales/cli/fr.json";
import hiCatalog from "../locales/cli/hi.json";
import itCatalog from "../locales/cli/it.json";
import jaCatalog from "../locales/cli/ja.json";
import koCatalog from "../locales/cli/ko.json";
import ptBRCatalog from "../locales/cli/pt-BR.json";
import ruCatalog from "../locales/cli/ru.json";
import zhCNCatalog from "../locales/cli/zh-CN.json";
import { officialCatalogLocale } from "./catalog-locale.ts";
import {
	type LiteralCatalog,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";

/**
 * The `cli` subset of the official literal catalogs, bundled statically for
 * the terminal CLI, a single compiled binary that cannot load chunks. Rebuild with `bun tools/i18n-catalog.mjs build`.
 */
const OFFICIAL_CLI_CATALOGS: Readonly<Record<string, LiteralCatalog>> = {
	ar: arCatalog,
	de: deCatalog,
	es: esCatalog,
	fr: frCatalog,
	hi: hiCatalog,
	it: itCatalog,
	ja: jaCatalog,
	ko: koCatalog,
	"pt-BR": ptBRCatalog,
	ru: ruCatalog,
	"zh-CN": zhCNCatalog,
};

/** The bundled `cli` catalog for `locale`, or null when none ships. */
export function officialCliLiteralCatalog(
	locale: string
): LiteralCatalog | null {
	const official = officialCatalogLocale(locale);
	return official ? (OFFICIAL_CLI_CATALOGS[official] ?? null) : null;
}

// Importing this module is the opt-in; the catalog answers synchronously.
registerLiteralCatalogLoader(officialCliLiteralCatalog);
