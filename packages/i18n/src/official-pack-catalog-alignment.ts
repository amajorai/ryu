import { literalMessageId } from "./message-id.ts";
import type { LanguagePack } from "./pack.ts";

/**
 * Named-pack values that used to repeat the English source while the official
 * literal catalog (`packages/i18n/locales/<locale>.json`) translates the same
 * text. A pack message is looked up before the catalog, so an English pack
 * value hid the catalog's translation ("Marketplace" in German instead of
 * "Marktplatz"). Each value below is the catalog's own translation, so a word
 * reads the same on every surface.
 *
 * `locales.ts` and `literal-translations.ts` are generated-size tables; this
 * overlay is applied to the official packs where `messages.ts` assembles the
 * built-in list. `tools/check-i18n-named-packs.mjs` fails when a pack value is
 * English again while the catalog translates it, unless `untranslated.json`
 * allowlists the word for that locale.
 */
export const OFFICIAL_PACK_CATALOG_ALIGNMENT: Readonly<
	Record<string, Readonly<Record<string, string>>>
> = {
	ar: {
		"common.marketplace": "السوق",
		"marketplace.surface.web": "الويب",
		"nav.marketplace": "السوق",
	},
	de: {
		"common.marketplace": "Marktplatz",
		"extension.apps.category.tool": "Werkzeug",
		[literalMessageId("Academy")]: "Akademie",
		[literalMessageId("Dashboard")]: "Übersicht",
		[literalMessageId("Plan")]: "Tarif",
		[literalMessageId("Self-hosted")]: "Selbst gehostet",
		"marketplace.section.marketplaces": "Marktplätze",
		"marketplace.section.skills": "Fähigkeiten",
		"marketplace.skills": "Fähigkeiten",
		"marketplace.support.legacy": "Veraltet",
		"nav.marketplace": "Marktplatz",
		"settings.nav.updates": "Aktualisierungen",
		"settings.page.updates": "Aktualisierungen",
		"sidebar.section.skills": "Fähigkeiten",
		"sidebar.section.tabs": "Registerkarten",
	},
	es: {
		"common.marketplace": "Mercado",
		"marketplace.section.marketplaces": "Mercados",
		"nav.marketplace": "Mercado",
	},
	fr: {
		"common.marketplace": "Place de marché",
		[literalMessageId("Plan")]: "Forfait",
		"marketplace.section.marketplaces": "Places de marché",
		"nav.marketplace": "Place de marché",
	},
	hi: {
		"common.marketplace": "मार्केटप्लेस",
		"marketplace.section.marketplaces": "मार्केटप्लेस",
		"marketplace.surface.web": "वेब",
		"nav.marketplace": "मार्केटप्लेस",
		"nav.store": "स्टोर",
	},
	it: {
		"common.marketplace": "Mercato",
		"extension.apps.category.provider": "Fornitore",
		[literalMessageId("Dashboard")]: "Pannello",
		[literalMessageId("Email")]: "E-mail",
		[literalMessageId("Self-hosted")]: "Auto-ospitato",
		"marketplace.section.home": "Pagina iniziale",
		"marketplace.support.legacy": "Obsoleto",
		"marketplace.surface.mobile": "Dispositivo mobile",
		"nav.home": "Pagina iniziale",
		"nav.marketplace": "Mercato",
	},
	ja: {
		"marketplace.surface.web": "ウェブ",
	},
	ko: {
		"common.marketplace": "마켓플레이스",
		"marketplace.surface.web": "웹",
		"nav.marketplace": "마켓플레이스",
	},
	"pt-BR": {
		"common.marketplace": "Mercado",
		[literalMessageId("Threads")]: "Linhas de execução",
		"marketplace.section.engines": "Motores",
		"marketplace.section.marketplaces": "Mercados",
		"marketplace.section.skills": "Habilidades",
		"marketplace.skills": "Habilidades",
		"nav.marketplace": "Mercado",
		"sidebar.section.engines": "Motores",
		"sidebar.section.skills": "Habilidades",
	},
	ru: {
		"common.marketplace": "Маркетплейс",
		"marketplace.surface.desktop": "Десктоп",
		"marketplace.surface.web": "Веб",
		"nav.marketplace": "Маркетплейс",
		"nav.store": "Магазин",
	},
	"zh-CN": {
		"common.marketplace": "市场",
		"marketplace.surface.web": "网页",
		"nav.marketplace": "市场",
	},
};

/** `pack` with its catalog-aligned values; packs without entries pass through. */
export function alignOfficialPackWithCatalog(pack: LanguagePack): LanguagePack {
	const alignment = OFFICIAL_PACK_CATALOG_ALIGNMENT[pack.locale];
	if (alignment === undefined || !pack.id.startsWith("official/")) {
		return pack;
	}
	return { ...pack, messages: { ...pack.messages, ...alignment } };
}
