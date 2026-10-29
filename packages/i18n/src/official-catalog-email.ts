import arCatalog from "../locales/email/ar.json";
import deCatalog from "../locales/email/de.json";
import esCatalog from "../locales/email/es.json";
import frCatalog from "../locales/email/fr.json";
import hiCatalog from "../locales/email/hi.json";
import itCatalog from "../locales/email/it.json";
import jaCatalog from "../locales/email/ja.json";
import koCatalog from "../locales/email/ko.json";
import ptBRCatalog from "../locales/email/pt-BR.json";
import ruCatalog from "../locales/email/ru.json";
import zhCNCatalog from "../locales/email/zh-CN.json";
import { officialCatalogLocale } from "./catalog-locale.ts";
import {
	type LiteralCatalog,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";

/**
 * The `email` subset of the official literal catalogs, bundled statically for
 * server-rendered email, which renders in the recipient's locale on
 * demand. Rebuild with `bun tools/i18n-catalog.mjs build`.
 */
const OFFICIAL_EMAIL_CATALOGS: Readonly<Record<string, LiteralCatalog>> = {
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

/** The bundled `email` catalog for `locale`, or null when none ships. */
export function officialEmailLiteralCatalog(
	locale: string
): LiteralCatalog | null {
	const official = officialCatalogLocale(locale);
	return official ? (OFFICIAL_EMAIL_CATALOGS[official] ?? null) : null;
}

// Importing this module is the opt-in; the catalog answers synchronously.
registerLiteralCatalogLoader(officialEmailLiteralCatalog);
