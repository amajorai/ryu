import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { I18nRuntime } from "./core.ts";
import { EN_MESSAGES } from "./en-messages.ts";
import { messageIdForLiteral } from "./literal-catalog.ts";
import { REPEATED_LITERAL_TRANSLATIONS } from "./literal-translations.ts";
import { literalMessageId } from "./message-id.ts";
import { BUILT_IN_LANGUAGE_PACKS } from "./messages.ts";
import { OFFICIAL_PACK_CATALOG_ALIGNMENT } from "./official-pack-catalog-alignment.ts";

// A named-pack message is tried before the literal catalog, so an English pack
// value must never hide a catalog translation of the same source.

const LOCALES_DIR = join(import.meta.dir, "..", "locales");

function readJson(file: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"));
}

const allowlist = readJson("untranslated.json") as Record<
	string,
	{ locales?: string[] }
>;
const sources = new Map<string, string>(Object.entries(EN_MESSAGES));
for (const source of Object.keys(REPEATED_LITERAL_TRANSLATIONS)) {
	sources.set(literalMessageId(source), source);
}
const officialPacks = BUILT_IN_LANGUAGE_PACKS.filter((pack) =>
	pack.id.startsWith("official/")
);

describe("official named packs agree with the literal catalogs", () => {
	test("no pack value repeats English while the catalog translates it", () => {
		const shadows: string[] = [];
		for (const pack of officialPacks) {
			const catalog = readJson(`${pack.locale}.json`);
			for (const [id, value] of Object.entries(pack.messages)) {
				const source = sources.get(id);
				const translated =
					source === undefined
						? undefined
						: catalog[source.replace(/\s+/gu, " ").trim()];
				if (
					source !== undefined &&
					value === source &&
					typeof translated === "string" &&
					translated !== source &&
					!allowlist[source]?.locales?.includes(pack.locale)
				) {
					shadows.push(`${pack.locale} ${id}: ${source} -> ${translated}`);
				}
			}
		}
		expect(shadows).toEqual([]);
	});

	test("every alignment value is the catalog's own translation", () => {
		const mismatches: string[] = [];
		for (const [locale, values] of Object.entries(
			OFFICIAL_PACK_CATALOG_ALIGNMENT
		)) {
			const catalog = readJson(`${locale}.json`);
			for (const [id, value] of Object.entries(values)) {
				const source = sources.get(id);
				if (source === undefined || catalog[source] !== value) {
					mismatches.push(`${locale} ${id}: ${value}`);
				}
			}
		}
		expect(mismatches).toEqual([]);
	});

	test("German and Russian resolve navigation words to their translations", () => {
		const german = new I18nRuntime([], { initialPackId: "official/de" });
		expect(german.translate(messageIdForLiteral("Marketplace"))).toBe(
			"Marktplatz"
		);
		expect(german.translate(messageIdForLiteral("Skills"))).toBe("Fähigkeiten");
		expect(
			german.translate(messageIdForLiteral("Academy"), {}, "Academy")
		).toBe("Akademie");
		const russian = new I18nRuntime([], { initialPackId: "official/ru" });
		expect(russian.translate("nav.store")).toBe("Магазин");
		const arabic = new I18nRuntime([], { initialPackId: "official/ar" });
		expect(arabic.translate(messageIdForLiteral("Marketplace"))).toBe("السوق");
		const japanese = new I18nRuntime([], { initialPackId: "official/ja" });
		expect(japanese.translate("marketplace.surface.web")).toBe("ウェブ");
		const portuguese = new I18nRuntime([], {
			initialPackId: "official/pt-br",
		});
		expect(portuguese.translate(messageIdForLiteral("Skills"))).toBe(
			"Habilidades"
		);
	});

	test("English stays English and alignment only overrides existing pack ids", () => {
		const english = new I18nRuntime([]);
		expect(english.translate(messageIdForLiteral("Marketplace"))).toBe(
			"Marketplace"
		);
		for (const pack of officialPacks) {
			const alignment = OFFICIAL_PACK_CATALOG_ALIGNMENT[pack.locale] ?? {};
			expect(Object.keys(alignment).every((id) => id in pack.messages)).toBe(
				true
			);
		}
	});
});
