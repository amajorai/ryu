import { describe, expect, test } from "bun:test";

// "No" is the answer opposite "Yes" at every call site (forms choices, CRM
// boolean fields, Agent Passport details, bot-flow quick replies). It must
// never carry the determiner of a "No {thing}" empty-state sentence, which an
// earlier split sentence left behind ("追加された", "Keine", "لم تتم إضافة أي").

/** The answer word every official locale must ship for the bare "No". */
const EXPECTED_NO: Readonly<Record<string, string>> = {
	ar: "لا",
	de: "Nein",
	es: "No",
	fr: "Non",
	hi: "नहीं",
	it: "No",
	ja: "いいえ",
	ko: "아니요",
	"pt-BR": "Não",
	ru: "Нет",
	"zh-CN": "否",
};

/** Determiner fragments of "No {thing}" sentences that "No" must not read as. */
const FRAGMENT_HEADS: Readonly<Record<string, readonly string[]>> = {
	ar: ["لم تتم إضافة أي", "لا يوجد", "لا توجد"],
	de: ["Kein", "Keine", "Keinen"],
	ja: ["追加された", "なし"],
};

/** Generated catalogs that carry the bare "No" for a Yes/No choice. */
const SUBSET_DIRECTORIES = [
	"apps/forms",
	"apps/bot-flows",
	"apps/social",
	"web",
] as const;

const readCatalog = async (path: string) =>
	(await Bun.file(
		new URL(`../locales/${path}.json`, import.meta.url)
	).json()) as Record<string, string>;

describe('"No" reads as the answer opposite "Yes"', () => {
	test.each(
		Object.entries(EXPECTED_NO)
	)("the root %s catalog ships the answer word", async (locale, expected) => {
		const catalog = await readCatalog(locale);
		expect(catalog.No).toBe(expected);
		expect(catalog.No).not.toBe(catalog.Yes);
	});

	test.each([
		"ja",
		"ar",
		"de",
	])("the %s app and web subsets agree with the root catalog", async (locale) => {
		for (const directory of SUBSET_DIRECTORIES) {
			const catalog = await readCatalog(`${directory}/${locale}`);
			expect({ directory, no: catalog.No }).toEqual({
				directory,
				no: EXPECTED_NO[locale],
			});
		}
	});

	test.each(
		Object.entries(FRAGMENT_HEADS)
	)('the %s "No" is not a "No {thing}" determiner', async (locale, heads) => {
		const catalog = await readCatalog(locale);
		const forms = await readCatalog(`apps/forms/${locale}`);
		for (const value of [catalog.No, forms.No]) {
			expect(heads).not.toContain(value);
		}
		// The "No {thing}" sentences keep their own determiner: the text
		// before their first placeholder is never the bare answer word.
		const sentenceHeads = Object.entries(catalog)
			.filter(([source]) => source.startsWith("No {"))
			.map(([, translation]) => translation.split("{")[0]?.trim() ?? "");
		expect(sentenceHeads.length).toBeGreaterThan(0);
		expect(sentenceHeads).not.toContain(catalog.No);
	});
});
