import arCatalog from "../locales/extension/ar.json";
import deCatalog from "../locales/extension/de.json";
import esCatalog from "../locales/extension/es.json";
import frCatalog from "../locales/extension/fr.json";
import hiCatalog from "../locales/extension/hi.json";
import itCatalog from "../locales/extension/it.json";
import jaCatalog from "../locales/extension/ja.json";
import koCatalog from "../locales/extension/ko.json";
import ptBRCatalog from "../locales/extension/pt-BR.json";
import ruCatalog from "../locales/extension/ru.json";
import zhCNCatalog from "../locales/extension/zh-CN.json";
import { officialCatalogLocale } from "./catalog-locale.ts";
import {
	type LiteralCatalog,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";

/**
 * The `extension` subset of the official literal catalogs, bundled statically for
 * the browser extension's content scripts and MV3 worker, which cannot
 * load chunks on demand. Rebuild with `bun tools/i18n-catalog.mjs build`.
 */
const OFFICIAL_EXTENSION_CATALOGS: Readonly<Record<string, LiteralCatalog>> = {
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

/** The bundled `extension` catalog for `locale`, or null when none ships. */
export function officialExtensionLiteralCatalog(
	locale: string
): LiteralCatalog | null {
	const official = officialCatalogLocale(locale);
	return official ? (OFFICIAL_EXTENSION_CATALOGS[official] ?? null) : null;
}

// Importing this module is the opt-in; the catalog answers synchronously.
registerLiteralCatalogLoader(officialExtensionLiteralCatalog);
