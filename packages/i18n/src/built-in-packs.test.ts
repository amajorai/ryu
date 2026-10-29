import { describe, expect, test } from "bun:test";
import { BUILT_IN_LANGUAGE_PACK_INFO } from "./built-in-pack-info.ts";
import { builtInLanguagePackForLocale, I18nRuntime } from "./core.ts";
import { findLanguagePackForLocale } from "./locale.ts";
import { BUILT_IN_LANGUAGE_PACKS } from "./messages.ts";
import {
	type LanguagePack,
	trustedBuiltInPack,
	validateLanguagePack,
} from "./pack.ts";
import { I18nRuntime as LiteRuntime } from "./runtime.ts";

const REQUEST_LOCALES = [
	"en",
	"en-GB",
	"es",
	"es-MX",
	"fr-CA",
	"pt",
	"pt-BR",
	"pt-PT",
	"zh",
	"zh-CN",
	"zh-TW",
	"ja-JP",
	"ar-EG",
	"he",
	"xx",
	"",
	"not a locale",
];

const spanish = BUILT_IN_LANGUAGE_PACKS.find(
	(pack) => pack.id === "official/es"
) as LanguagePack;

describe("built-in catalog contract", () => {
	test("the metadata list mirrors every built-in pack in order", () => {
		expect(BUILT_IN_LANGUAGE_PACK_INFO).toEqual(
			BUILT_IN_LANGUAGE_PACKS.map((pack) => ({
				baseLocale: pack.baseLocale,
				direction: pack.direction,
				id: pack.id,
				locale: pack.locale,
				name: pack.name,
			}))
		);
	});

	test("every built-in pack passes validation unchanged, so runtimes can trust it", () => {
		for (const pack of BUILT_IN_LANGUAGE_PACKS) {
			const validated = {
				...validateLanguagePack(pack),
				enabled: pack.enabled !== false,
			};
			// Same keys, values and key order as the validated runtime entry.
			expect(JSON.stringify(trustedBuiltInPack(pack))).toBe(
				JSON.stringify(validated)
			);
			expect(trustedBuiltInPack(pack).messages).not.toBe(pack.messages);
		}
	});

	test("the server's request pack is the one a runtime auto-selects", () => {
		for (const locale of REQUEST_LOCALES) {
			const runtime = new I18nRuntime([], {
				initialLocale: locale,
				initialPackId: null,
			});
			expect(builtInLanguagePackForLocale(locale)?.id ?? null).toBe(
				runtime.selectedPackId
			);
			// Metadata alone answers the same question for a lazy-loading page.
			expect(
				findLanguagePackForLocale(BUILT_IN_LANGUAGE_PACK_INFO, locale)?.id ??
					null
			).toBe(runtime.selectedPackId);
		}
		expect(builtInLanguagePackForLocale(null)).toBeNull();
	});
});

describe("runtime built-in packs", () => {
	test("a runtime from @ryu/i18n/core starts with every bundled pack", () => {
		const runtime = new I18nRuntime([], { initialPackId: null });
		expect(runtime.availablePacks.map((pack) => pack.id)).toEqual(
			BUILT_IN_LANGUAGE_PACKS.map((pack) => pack.id)
		);
	});

	test("a lite runtime holds only the packs it is given and reserves the rest", () => {
		const reservedIds = BUILT_IN_LANGUAGE_PACK_INFO.map((pack) => pack.id);
		const impostor: LanguagePack = {
			...spanish,
			id: "official/fr",
			messages: { "common.active": "Hijacked" },
		};
		const runtime = new LiteRuntime(
			[impostor],
			{ initialLocale: "es-MX", initialPackId: null },
			{ packs: [spanish], reservedIds }
		);
		expect(runtime.availablePacks.map((pack) => pack.id)).toEqual([
			"official/es",
		]);
		expect(runtime.selectedPackId).toBe("official/es");
		expect(runtime.translate("common.active")).toBe("Activo");
	});

	test("loading the catalog later completes an auto-detected locale", () => {
		const runtime = new LiteRuntime(
			[],
			{ initialLocale: "fr-CA", initialPackId: null },
			{ packs: [] }
		);
		expect(runtime.selectedPackId).toBeNull();
		expect(runtime.locale).toBe("fr-CA");
		let notified = 0;
		runtime.subscribe(() => {
			notified += 1;
		});
		runtime.setBuiltInPacks(BUILT_IN_LANGUAGE_PACKS);
		expect(notified).toBe(1);
		expect(runtime.selectedPackId).toBe("official/fr");
		expect(runtime.translate("common.active")).toBe(
			new I18nRuntime([], { initialPackId: "official/fr" }).translate(
				"common.active"
			)
		);
	});

	test("replacing built-ins keeps the remote packs it was given", () => {
		const remote: LanguagePack = {
			baseLocale: "en",
			direction: "ltr",
			id: "community/pirate",
			locale: "en",
			messages: { "common.active": "Arr" },
			name: "Pirate",
			schemaVersion: 1,
			version: "1.0.0",
		};
		const runtime = new LiteRuntime(
			[remote],
			{ initialPackId: "community/pirate" },
			{ packs: [] }
		);
		runtime.setBuiltInPacks([spanish]);
		expect(runtime.availablePacks.map((pack) => pack.id)).toEqual([
			"official/es",
			"community/pirate",
		]);
		expect(runtime.translate("common.active")).toBe("Arr");
	});
});
