import arCatalog from "../locales/email/ar.json" with { type: "json" };
import deCatalog from "../locales/email/de.json" with { type: "json" };
import esCatalog from "../locales/email/es.json" with { type: "json" };
import frCatalog from "../locales/email/fr.json" with { type: "json" };
import hiCatalog from "../locales/email/hi.json" with { type: "json" };
import itCatalog from "../locales/email/it.json" with { type: "json" };
import jaCatalog from "../locales/email/ja.json" with { type: "json" };
import koCatalog from "../locales/email/ko.json" with { type: "json" };
import plCatalog from "../locales/email/pl.json" with { type: "json" };
import ptBRCatalog from "../locales/email/pt-BR.json" with { type: "json" };
import ruCatalog from "../locales/email/ru.json" with { type: "json" };
import zhCNCatalog from "../locales/email/zh-CN.json" with { type: "json" };
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
	pl: plCatalog,
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
