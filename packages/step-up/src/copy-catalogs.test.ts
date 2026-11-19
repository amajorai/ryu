import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STEP_UP_CONFIRM_COPY, STEP_UP_METHOD_LABEL } from "./copy.ts";

// The step-up prompt's sentences and factor labels are looked up by exact
// English text on every surface: the web and desktop DOM localizers, the
// native catalog lookup, and the extension's pages. This reads the catalogs
// those surfaces actually ship (not stand-ins) and checks every sentence has a
// real translation in each, so an extraction or routing regression that drops
// them from one surface fails here.
const LOCALES = [
	"ar",
	"de",
	"es",
	"fr",
	"hi",
	"it",
	"ja",
	"ko",
	"pt-BR",
	"ru",
	"zh-CN",
] as const;
const CATALOGS = ["", "web", "native", "extension"] as const;
const LOCALES_DIR = join(import.meta.dir, "../../i18n/locales");

function shippedCatalog(
	surface: (typeof CATALOGS)[number],
	locale: string
): Record<string, string> {
	const path = join(LOCALES_DIR, surface, `${locale}.json`);
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

const SENTENCES = [
	...Object.values(STEP_UP_CONFIRM_COPY).flatMap((byMethod) =>
		Object.values(byMethod)
	),
	...Object.values(STEP_UP_METHOD_LABEL),
];

describe("shipped catalogs carry every step-up sentence", () => {
	it("covers the 66 sentences and 5 labels", () => {
		expect(new Set(SENTENCES).size).toBe(71);
	});

	for (const surface of CATALOGS) {
		for (const locale of LOCALES) {
			it(`${surface || "root"} ${locale}`, () => {
				const catalog = shippedCatalog(surface, locale);
				const missing = SENTENCES.filter((english) => {
					const translated = catalog[english];
					return !translated || translated === english;
				});
				expect(missing).toEqual([]);
			});
		}
	}
});
