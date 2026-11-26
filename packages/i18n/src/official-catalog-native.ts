import arCatalog from "../locales/native/ar.json" with { type: "json" };
import deCatalog from "../locales/native/de.json" with { type: "json" };
import esCatalog from "../locales/native/es.json" with { type: "json" };
import frCatalog from "../locales/native/fr.json" with { type: "json" };
import hiCatalog from "../locales/native/hi.json" with { type: "json" };
import itCatalog from "../locales/native/it.json" with { type: "json" };
import jaCatalog from "../locales/native/ja.json" with { type: "json" };
import koCatalog from "../locales/native/ko.json" with { type: "json" };
import plCatalog from "../locales/native/pl.json" with { type: "json" };
import ptBRCatalog from "../locales/native/pt-BR.json" with { type: "json" };
import ruCatalog from "../locales/native/ru.json" with { type: "json" };
import zhCNCatalog from "../locales/native/zh-CN.json" with { type: "json" };
import { officialCatalogLocale } from "./catalog-locale.ts";
import {
	type LiteralCatalog,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";

/**
 * The `native` subset of the official literal catalogs, bundled statically for
 * React Native (Metro inlines dynamic imports, so the app bundles only
 * the strings its own screens render). Rebuild with `bun tools/i18n-catalog.mjs build`.
 */
const OFFICIAL_NATIVE_CATALOGS: Readonly<Record<string, LiteralCatalog>> = {
	ar: arCatalog,
	de: deCatalog,
	es: esCatalog,
	fr: frCatalog,
	hi: hiCatalog,
	it: itCatalog,
	ja: jaCatalog,
	ko: koCatalog,
	pl: plCatalog,
	"pt-BR": ptBRCatalog,
	ru: ruCatalog,
	"zh-CN": zhCNCatalog,
};

/** The bundled `native` catalog for `locale`, or null when none ships. */
export function officialNativeLiteralCatalog(
	locale: string
): LiteralCatalog | null {
	const official = officialCatalogLocale(locale);
	return official ? (OFFICIAL_NATIVE_CATALOGS[official] ?? null) : null;
}

// Importing this module is the opt-in; the catalog answers synchronously.
registerLiteralCatalogLoader(officialNativeLiteralCatalog);
