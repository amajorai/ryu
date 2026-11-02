import arCatalog from "../locales/bot/ar.json";
import deCatalog from "../locales/bot/de.json";
import esCatalog from "../locales/bot/es.json";
import frCatalog from "../locales/bot/fr.json";
import hiCatalog from "../locales/bot/hi.json";
import itCatalog from "../locales/bot/it.json";
import jaCatalog from "../locales/bot/ja.json";
import koCatalog from "../locales/bot/ko.json";
import ptBRCatalog from "../locales/bot/pt-BR.json";
import ruCatalog from "../locales/bot/ru.json";
import zhCNCatalog from "../locales/bot/zh-CN.json";
import { officialCatalogLocale } from "./catalog-locale.ts";
import {
	type LiteralCatalog,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";

/**
 * The `bot` subset of the official literal catalogs, bundled statically for
 * the hosted chat bot (`apps/cloud-bot`), which translates each canned reply
 * into the recipient's locale before it sends it. It holds only the bot's own
 * `t.tl()`/`t.tf()` messages, so the bot never loads the full UI catalog.
 * Rebuild with `bun tools/i18n-catalog.mjs build`.
 */
const OFFICIAL_BOT_CATALOGS: Readonly<Record<string, LiteralCatalog>> = {
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

/** The bundled `bot` catalog for `locale`, or null when none ships. */
export function officialBotLiteralCatalog(
	locale: string
): LiteralCatalog | null {
	const official = officialCatalogLocale(locale);
	return official ? (OFFICIAL_BOT_CATALOGS[official] ?? null) : null;
}

// Importing this module is the opt-in; the catalog answers synchronously.
registerLiteralCatalogLoader(officialBotLiteralCatalog);
