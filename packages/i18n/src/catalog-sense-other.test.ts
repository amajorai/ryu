import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// "Other" is almost always a neutral catch-all category (a story or perk
// category, a report reason, a usage bucket, a license kind), so it takes the
// neutral form. It used to read as "another amount" (مبلغ آخر) or agree with
// one specific noun (Anderer, Другая), which was wrong everywhere else.

const EXPECTED: Readonly<Record<string, string>> = {
	ar: "أخرى",
	de: "Sonstiges",
	es: "Otro",
	fr: "Autre",
	hi: "अन्य",
	it: "Altro",
	ja: "その他",
	ko: "기타",
	"pt-BR": "Outro",
	ru: "Другое",
	"zh-CN": "其他",
};

const LOCALES_DIR = new URL("../locales/", import.meta.url);

const readCatalog = async (path: string) =>
	(await Bun.file(new URL(path, LOCALES_DIR)).json()) as Record<string, string>;

describe('"Other" reads as a neutral category', () => {
	test.each(
		Object.entries(EXPECTED)
	)("the root %s catalog uses the neutral catch-all form", async (locale, expected) => {
		const catalog = await readCatalog(`${locale}.json`);
		expect(catalog.Other).toBe(expected);
	});

	test("every generated subset agrees with its root catalog", async () => {
		const mismatches: string[] = [];
		const glob = new Bun.Glob("*/**/*.json");
		for await (const path of glob.scan(fileURLToPath(LOCALES_DIR))) {
			const locale =
				path
					.split("/")
					.at(-1)
					?.replace(/\.json$/, "") ?? "";
			const expected = EXPECTED[locale];
			if (expected === undefined) {
				continue;
			}
			const value = (await readCatalog(path)).Other;
			if (value !== undefined && value !== expected) {
				mismatches.push(`${path}: ${value}`);
			}
		}
		expect(mismatches).toEqual([]);
	});
});
