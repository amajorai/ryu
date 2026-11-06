import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { officialCatalogLocale } from "./catalog-locale.ts";
import {
	LIKELY_SCRIPTS,
	likelyLanguageAndScript,
	likelyScript,
	matchByLikelyScript,
	REGION_SCRIPTS,
} from "./likely-script.ts";
import {
	findLanguagePackForLocale,
	localeLanguageAndScript,
} from "./locale.ts";

/** Run `body` as an engine without `Intl.Locale` (Hermes in React Native). */
function withoutIntlLocale<Result>(body: () => Result): Result {
	const saved: unknown = Reflect.get(Intl, "Locale");
	try {
		Reflect.deleteProperty(Intl, "Locale");
		return body();
	} finally {
		Reflect.set(Intl, "Locale", saved);
	}
}

const OFFICIAL_PACKS = [
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
].map((locale) => ({ enabled: true, locale }));

/** A copy of Core's `LIKELY_SCRIPTS` and `REGION_SCRIPTS` (apps/core/src/i18n/locale.rs). */
const CORE_LIKELY_SCRIPTS: Record<string, string> = {
	ar: "Arab",
	de: "Latn",
	es: "Latn",
	fr: "Latn",
	hi: "Deva",
	it: "Latn",
	ja: "Jpan",
	ko: "Kore",
	pt: "Latn",
	ru: "Cyrl",
	zh: "Hans",
};
const CORE_HANT_REGIONS =
	"AU BN GB GF HK ID MO PA PF PH PZ SR TH TW UK US VD VN".split(" ");

describe("official catalog without Intl.Locale", () => {
	test("Traditional Chinese has no official catalog", () => {
		withoutIntlLocale(() => {
			for (const tag of ["zh-TW", "zh-Hant-TW", "zh-HK", "zh-MO", "zh-Hant"]) {
				expect(officialCatalogLocale(tag)).toBeNull();
			}
		});
	});

	test("Simplified Chinese and same-script regions match", () => {
		withoutIntlLocale(() => {
			expect(officialCatalogLocale("zh-SG")).toBe("zh-CN");
			expect(officialCatalogLocale("zh-Hans-CN")).toBe("zh-CN");
			expect(officialCatalogLocale("zh")).toBe("zh-CN");
			expect(officialCatalogLocale("pt-PT")).toBe("pt-BR");
			expect(officialCatalogLocale("es-MX")).toBe("es");
			expect(officialCatalogLocale("ja")).toBe("ja");
			expect(officialCatalogLocale("ja-JP")).toBe("ja");
			expect(officialCatalogLocale("ar-SA")).toBe("ar");
			expect(officialCatalogLocale("de-AT")).toBe("de");
			expect(officialCatalogLocale("zh_TW.UTF-8")).toBeNull();
			expect(officialCatalogLocale("nl-BE")).toBeNull();
			expect(officialCatalogLocale("")).toBeNull();
		});
	});

	test("agrees with Intl.Locale where the engine has it", () => {
		const tags = [
			"zh-TW",
			"zh-HK",
			"zh-SG",
			"zh-Hant-CN",
			"pt-PT",
			"es-MX",
			"ja-JP",
			"ar-SA",
			"de-AT",
		];
		const withIntl = tags.map((tag) => officialCatalogLocale(tag));
		const without = withoutIntlLocale(() =>
			tags.map((tag) => officialCatalogLocale(tag))
		);
		expect(without).toEqual(withIntl);
	});
});

describe("language pack matching without Intl.Locale", () => {
	test("zh-Hant tags get no Simplified Chinese pack", () => {
		withoutIntlLocale(() => {
			expect(findLanguagePackForLocale(OFFICIAL_PACKS, "zh-TW")).toBeNull();
			expect(
				findLanguagePackForLocale(OFFICIAL_PACKS, "zh-Hant-TW")
			).toBeNull();
			expect(findLanguagePackForLocale(OFFICIAL_PACKS, "zh-HK")).toBeNull();
			expect(findLanguagePackForLocale(OFFICIAL_PACKS, "zh-SG")?.locale).toBe(
				"zh-CN"
			);
			expect(findLanguagePackForLocale(OFFICIAL_PACKS, "pt-PT")?.locale).toBe(
				"pt-BR"
			);
			expect(findLanguagePackForLocale(OFFICIAL_PACKS, "en-GB")).toBeNull();
		});
	});

	test("user packs without a known script still match by language", () => {
		withoutIntlLocale(() => {
			const dutch = [{ enabled: true, locale: "nl" }];
			expect(findLanguagePackForLocale(dutch, "nl-BE")?.locale).toBe("nl");
			expect(localeLanguageAndScript("zh-TW")).toBe("zh-hant");
		});
	});
});

describe("likelyScript", () => {
	test("an explicit script wins, then the region, then the language", () => {
		expect(likelyScript("zh-Hant-CN")).toBe("Hant");
		expect(likelyScript("zh-hans-TW")).toBe("Hans");
		expect(likelyScript("zh_TW.UTF-8")).toBe("Hant");
		expect(likelyScript("zh-SG")).toBe("Hans");
		expect(likelyScript("sr-Latn")).toBe("Latn");
		expect(likelyScript("nl")).toBeNull();
		expect(likelyLanguageAndScript("PT-pt")).toBe("pt-latn");
		expect(matchByLikelyScript("zh-MO", ["zh-CN"])).toBeNull();
	});

	test("matches Intl.Locale#maximize for the official languages", () => {
		for (const language of Object.keys(LIKELY_SCRIPTS)) {
			for (const tag of [language, `${language}-TW`, `${language}-SG`]) {
				expect(likelyScript(tag)).toBe(
					new Intl.Locale(tag).maximize().script ?? null
				);
			}
		}
	});

	test("keeps parity with Core's tables", () => {
		expect({ ...LIKELY_SCRIPTS }).toEqual(CORE_LIKELY_SCRIPTS);
		expect(REGION_SCRIPTS).toEqual({ zh: CORE_HANT_REGIONS });
		const coreSource = readFileSync(
			new URL("../../../apps/core/src/i18n/locale.rs", import.meta.url),
			"utf8"
		);
		const coreLikely = [
			...coreSource.matchAll(/^\s*\("([a-z]+)", "([A-Z][a-z]{3})"\),$/gmu),
		].map(([, language, script]) => [language, script]);
		const coreRegions = [
			...coreSource.matchAll(/^\s*\("zh", "([A-Z]{2})", "Hant"\),$/gmu),
		].map(([, region]) => region);
		expect(Object.fromEntries(coreLikely)).toEqual(CORE_LIKELY_SCRIPTS);
		expect(coreRegions).toEqual(CORE_HANT_REGIONS);
	});
});
