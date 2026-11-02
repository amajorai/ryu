import { describe, expect, test } from "bun:test";

import { I18nRuntime } from "./core.ts";
import {
	acceptLanguageLocales,
	localeFromAcceptLanguage,
	preferredOfficialLocale,
	systemLocales,
} from "./locale.ts";
import type { LanguagePack } from "./pack.ts";

describe("Accept-Language", () => {
	test("lists valid tags best first", () => {
		expect(
			acceptLanguageLocales("fr;q=0.5, pt-br, *;q=0.1, de;q=0.5, ja;q=0, xx_YY")
		).toEqual(["pt-BR", "fr", "de"]);
		expect(acceptLanguageLocales(null)).toEqual([]);
	});

	test("answers the first language Ryu can show", () => {
		expect(localeFromAcceptLanguage("nl-NL,nl;q=0.9,de;q=0.8")).toBe("de");
		expect(localeFromAcceptLanguage("rm, de-CH;q=0.9, fr;q=0.8")).toBe("de-CH");
		expect(localeFromAcceptLanguage("zh-TW, ja;q=0.9")).toBe("ja");
		// English listed before a supported voice is a choice of English.
		expect(localeFromAcceptLanguage("nl, en-GB;q=0.9, de;q=0.8")).toBe("en-GB");
		// Nothing showable: the best tag still drives formatting.
		expect(localeFromAcceptLanguage("nl-NL, sv;q=0.5")).toBe("nl-NL");
		expect(localeFromAcceptLanguage("xx")).toBe("xx");
	});

	test("counts installed packs as showable", () => {
		const dutch = [{ enabled: true, locale: "nl" }];
		expect(localeFromAcceptLanguage("nl-NL, de;q=0.8", dutch)).toBe("nl-NL");
		expect(preferredOfficialLocale(["sv", "nl-BE"], dutch)).toBe("nl-BE");
		expect(preferredOfficialLocale(["sv", "nl-BE"])).toBeNull();
		expect(
			preferredOfficialLocale(
				["nl-BE", "de"],
				[{ enabled: false, locale: "nl" }]
			)
		).toBe("de");
	});
});

describe("system locales", () => {
	test("read navigator.languages, then navigator.language", () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		try {
			Object.defineProperty(globalThis, "navigator", {
				configurable: true,
				value: { language: "de-DE", languages: ["nl-NL", "de-DE"] },
			});
			expect(systemLocales()).toEqual(["nl-NL", "de-DE"]);
			Object.defineProperty(globalThis, "navigator", {
				configurable: true,
				value: { language: "de-DE", languages: [] },
			});
			expect(systemLocales()).toEqual(["de-DE"]);
			Object.defineProperty(globalThis, "navigator", {
				configurable: true,
				value: undefined,
			});
			expect(systemLocales()).toEqual([]);
		} finally {
			if (original) {
				Object.defineProperty(globalThis, "navigator", original);
			}
		}
	});
});

describe("runtime preference lists", () => {
	const dutchPack: LanguagePack = {
		baseLocale: "en",
		direction: "ltr",
		enabled: true,
		id: "community/nl",
		locale: "nl",
		messages: { "common.cancel": "Annuleren" },
		name: "Nederlands",
		schemaVersion: 1,
		version: "1.0.0",
	};

	test("select the first preference with a pack", () => {
		const runtime = new I18nRuntime([], {
			initialLocale: ["nl-NL", "de-AT", "fr"],
			initialPackId: null,
		});
		expect(runtime.selectedPackId).toBe("official/de");
		expect(runtime.translate("common.cancel")).toBe("Abbrechen");
	});

	test("keep English when it comes first, and the first tag when none fits", () => {
		const english = new I18nRuntime([], {
			initialLocale: ["sv", "en-GB", "de"],
			initialPackId: null,
		});
		expect(english.selectedPackId).toBeNull();
		expect(english.locale).toBe("en-GB");
		const none = new I18nRuntime([], {
			initialLocale: ["sv-SE", "nl"],
			initialPackId: null,
		});
		expect(none.selectedPackId).toBeNull();
		expect(none.locale).toBe("sv-SE");
	});

	test("adopt a preferred pack installed later", () => {
		const runtime = new I18nRuntime([], {
			initialLocale: ["nl-NL", "sv"],
			initialPackId: null,
		});
		expect(runtime.selectedPackId).toBeNull();
		runtime.setPacks([dutchPack]);
		expect(runtime.selectedPackId).toBe("community/nl");
		expect(runtime.translate("common.cancel")).toBe("Annuleren");
	});

	test("setLocale takes a list; applySystemLocales leaves a picked pack", () => {
		const persisted: (string | null)[] = [];
		const runtime = new I18nRuntime([], {
			initialLocale: "en",
			initialPackId: null,
			persistPackId: (id) => {
				persisted.push(id);
			},
		});
		runtime.setLocale(["sv", "ja"]);
		expect(runtime.selectedPackId).toBe("official/ja");
		runtime.applySystemLocales(["ko"]);
		expect(runtime.selectedPackId).toBe("official/ko");
		runtime.selectPack("official/fr");
		runtime.applySystemLocales(["de"]);
		expect(runtime.selectedPackId).toBe("official/fr");
		expect(persisted).toEqual(["official/ja", "official/fr"]);
	});
});

describe("preference lists on catalog-only runtimes", () => {
	test("an official literal catalog serves a later preference without a pack", async () => {
		const { I18nRuntime } = await import("./lite.ts");
		const { registerLiteralCatalogLoader } = await import(
			"./literal-catalog.ts"
		);
		registerLiteralCatalogLoader((locale) =>
			locale.startsWith("de") ? { Hello: "Hallo" } : null
		);
		try {
			const runtime = new I18nRuntime([], {
				initialLocale: ["nl-NL", "de"],
				initialPackId: null,
			});
			expect(runtime.locale).toBe("de");
			const english = new I18nRuntime([], {
				initialLocale: ["nl-NL", "en-GB", "de"],
				initialPackId: null,
			});
			expect(english.locale).toBe("en-GB");
		} finally {
			registerLiteralCatalogLoader(null);
		}
	});
});
