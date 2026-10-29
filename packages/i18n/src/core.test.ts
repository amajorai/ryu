import { describe, expect, spyOn, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import {
	formatMessage,
	I18nRuntime,
	LanguagePackValidationError,
	languagePackArchive,
	languagePackJson,
	languagePackPortableManifest,
	literalMessageId,
	localeFromAcceptLanguage,
	MAX_LANGUAGE_PACK_BYTES,
	messageIdForLiteral,
	parseLanguagePackArchive,
	parseLanguagePackJson,
	validateLanguagePack,
} from "./core.ts";
import { REPEATED_LITERAL_TRANSLATIONS } from "./literal-translations.ts";
import { BUILT_IN_LANGUAGE_PACKS, EN_MESSAGES } from "./messages.ts";

describe("message formatter resource bounds", () => {
	test("leaves excessive length, nesting and node counts literal", () => {
		const messages = [
			`${"{x, select, other{".repeat(6000)}Hello${"}}".repeat(6000)}`,
			`${"{x, select, other{".repeat(40)}Hello${"}}".repeat(40)}`,
			"{x}".repeat(1025),
			`{x, select, a{safe} other{${"{".repeat(40)}${"}}".repeat(40)}`,
		];
		const started = performance.now();
		for (const message of messages) {
			expect(formatMessage(message, { x: "a" })).toBe(message);
		}
		// The original 6,000-level payload took seconds and overflowed the
		// stack. This generous ceiling catches that regression without load.
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("preserves nested select/plural and normal interpolation", () => {
		expect(
			formatMessage(
				"{kind, select, files{{n, plural, one{# file for {name}} other{# files for {name}}}} other{None}}",
				{ kind: "files", n: 2, name: "Ada" }
			)
		).toBe("2 files for Ada");
		expect(formatMessage("{name}".repeat(1024), { name: "a" })).toBe(
			"a".repeat(1024)
		);
	});
});

describe("message formatter reuse", () => {
	test("constructs locale formatters once across repeated cardinal and ordinal messages", () => {
		const NumberFormat = Intl.NumberFormat;
		const PluralRules = Intl.PluralRules;
		let numbers = 0;
		let plurals = 0;
		Intl.NumberFormat = new Proxy(NumberFormat, {
			construct(target, args) {
				numbers += 1;
				return Reflect.construct(target, args);
			},
		});
		Reflect.set(
			Intl,
			"PluralRules",
			new Proxy(PluralRules, {
				construct(target, args) {
					plurals += 1;
					return Reflect.construct(target, args);
				},
			})
		);
		try {
			for (let count = 1; count <= 1000; count += 1) {
				formatMessage(
					"{n, plural, one {# item} other {# items}}",
					{ n: count },
					"en-x-reuse"
				);
				formatMessage(
					"{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
					{ n: count },
					"en-x-reuse"
				);
			}
			expect(numbers).toBe(1);
			expect(plurals).toBe(2);
		} finally {
			Intl.NumberFormat = NumberFormat;
			Reflect.set(Intl, "PluralRules", PluralRules);
		}
	});
	test("preserves locale-specific categories, number formatting, exact matches and invalid-locale errors", () => {
		for (const locale of ["en", "ar", "ru", "de", "hi", "fr"]) {
			for (const count of [0, 1, 2, 3, 11, 1000]) {
				const category = new Intl.PluralRules(locale).select(count);
				const number = new Intl.NumberFormat(locale).format(count);
				expect(
					formatMessage(
						"{n, plural, zero {zero #} one {one #} two {two #} few {few #} many {many #} other {other #}}",
						{ n: count },
						locale
					)
				).toBe(`${category} ${number}`);
			}
		}
		expect(
			formatMessage("{n, plural, =2 {exact #} other {other #}}", { n: 2 }, "en")
		).toBe("exact 2");
		expect(() =>
			formatMessage("{n, plural, other {#}}", { n: 2 }, "not_a_locale")
		).toThrow(RangeError);
	});
	test("evicts old locale entries so arbitrary input cannot grow the cache without bound", () => {
		const message = "{n, plural, other {#}}";
		formatMessage(message, { n: 5 }, "en-x-evict");
		for (let index = 0; index < 40; index += 1) {
			formatMessage(message, { n: 5 }, `en-x-cache${index}`);
		}
		const numbers = spyOn(Intl, "NumberFormat");
		try {
			expect(formatMessage(message, { n: 5 }, "en-x-evict")).toBe("5");
			expect(numbers).toHaveBeenCalledTimes(1);
		} finally {
			numbers.mockRestore();
		}
	});
});

describe("language-pack contract", () => {
	test("ships complete starter catalogs for common locales", () => {
		const official = BUILT_IN_LANGUAGE_PACKS.filter((pack) =>
			pack.id.startsWith("official/")
		);
		expect(official.map((pack) => pack.locale)).toEqual([
			"es",
			"fr",
			"de",
			"pt-BR",
			"ja",
			"zh-CN",
			"it",
			"ko",
			"hi",
			"ru",
			"ar",
		]);
		for (const pack of official) {
			expect(
				Object.keys(pack.messages)
					.filter((id) => !id.startsWith("literal."))
					.sort()
			).toEqual(Object.keys(EN_MESSAGES).sort());
			expect(
				Object.keys(pack.messages)
					.filter((id) => id.startsWith("literal."))
					.sort()
			).toEqual(
				Object.keys(REPEATED_LITERAL_TRANSLATIONS)
					.map((value) => literalMessageId(value))
					.sort()
			);
			expect(validateLanguagePack(pack)).toMatchObject({
				baseLocale: "en",
				direction: pack.locale === "ar" ? "rtl" : "ltr",
				locale: pack.locale,
			});
		}
	});

	test("auto-selects the closest starter locale without changing English defaults", () => {
		const spanish = new I18nRuntime([], {
			initialLocale: "es-MX",
			initialPackId: null,
		});
		expect(spanish.selectedPackId).toBe("official/es");
		expect(spanish.locale).toBe("es");
		expect(spanish.translate("chat.new")).toBe("Nuevo chat");

		const portuguese = new I18nRuntime([], {
			initialLocale: "pt-PT",
			initialPackId: null,
		});
		expect(portuguese.selectedPackId).toBe("official/pt-br");
		expect(portuguese.translate("common.cancel")).toBe("Cancelar");

		const traditionalChinese = new I18nRuntime([], {
			initialLocale: "zh-Hant-TW",
			initialPackId: null,
		});
		expect(traditionalChinese.selectedPackId).toBeNull();
		expect(traditionalChinese.locale).toBe("zh-Hant-TW");

		const arabic = new I18nRuntime([], {
			initialLocale: "ar-SA",
			initialPackId: null,
		});
		expect(arabic.selectedPackId).toBe("official/ar");
		expect(arabic.direction).toBe("rtl");
		expect(arabic.translate("common.cancel")).toBe("إلغاء");

		const english = new I18nRuntime([], {
			initialLocale: "en-US",
			initialPackId: null,
		});
		expect(english.selectedPackId).toBeNull();
		expect(english.translate("common.install")).toBe("Install");
	});

	test("resolves request locales by quality without accepting invalid tags", () => {
		expect(localeFromAcceptLanguage("fr-CA;q=0.4, ar-SA;q=0.9, en;q=0.8")).toBe(
			"ar-SA"
		);
		expect(localeFromAcceptLanguage("en_US;q=0.9, de;q=0.5")).toBe("de");
		expect(localeFromAcceptLanguage("*;q=0.5")).toBe("en");
		expect(localeFromAcceptLanguage(null)).toBe("en");
	});

	test("keeps legacy literal ids deterministic and reuses catalog ids", () => {
		const first = messageIdForLiteral("Search");
		expect(first).toBe("common.search");
		expect(messageIdForLiteral("Search")).toBe(first);
		expect(messageIdForLiteral("A legacy control")).toMatch(
			/^literal\.a-legacy-control\.[0-9a-f]{8}$/u
		);
	});

	test("formats interpolation, select, and plural messages", () => {
		expect(formatMessage("Hello, {name}!", { name: "Ari" })).toBe(
			"Hello, Ari!"
		);
		expect(
			formatMessage(
				"{count, plural, one {# file} other {# files}}",
				{ count: 2 },
				"en"
			)
		).toBe("2 files");
		expect(
			formatMessage("{mode, select, compact {Compact} other {Detailed}}", {
				mode: "compact",
			})
		).toBe("Compact");
	});

	test("rejects malformed identity and placeholder changes", () => {
		expect(() =>
			validateLanguagePack({
				baseLocale: "en",
				direction: "ltr",
				id: "../unsafe",
				locale: "en",
				messages: { "sample.greeting": "Hi" },
				name: "Unsafe",
				schemaVersion: 1,
				version: "1.0.0",
			})
		).toThrow(LanguagePackValidationError);
		expect(() =>
			validateLanguagePack({
				baseLocale: "en",
				direction: "ltr",
				id: "community/broken",
				locale: "en",
				messages: { "chat.delete-description": "Delete this?" },
				name: "Broken placeholders",
				schemaVersion: 1,
				version: "1.0.0",
			})
		).toThrow("placeholders must match the source");
	});

	test("layers a selected custom pack over the English source catalog", () => {
		const runtime = new I18nRuntime([
			{
				baseLocale: "en",
				direction: "ltr",
				enabled: true,
				id: "test-pack",
				locale: "en",
				messages: { "sample.greeting": "Yo, {name}." },
				name: "Test pack",
				schemaVersion: 1,
				version: "1.0.0",
			},
		]);
		runtime.selectPack("test-pack");
		expect(runtime.translate("sample.greeting", { name: "Ari" })).toBe(
			"Yo, Ari."
		);
		expect(runtime.translate("common.cancel")).toBe("Cancel");
	});

	test("does not apply an unselected built-in voice to the English fallback", () => {
		const runtime = new I18nRuntime();
		expect(runtime.translate("common.install")).toBe("Install");
		runtime.selectPack("en-x-ryu-online");
		expect(runtime.translate("common.install")).toBe("Yeet it in");
		expect(runtime.getSnapshot()).toMatchObject({
			locale: "en",
			packId: "en-x-ryu-online",
			packName: "English (chronically online)",
			packVersion: "1.0.0",
		});
	});

	test("translates repeated legacy UI literals through stable ids", () => {
		const runtime = new I18nRuntime([], {
			initialLocale: "es-MX",
			initialPackId: null,
		});
		expect(
			runtime.translate(
				messageIdForLiteral("Open in new tab"),
				{},
				"Open in new tab"
			)
		).toBe("Abrir en una pestaña nueva");
		expect(
			runtime.translate(messageIdForLiteral("Loading…"), {}, "Loading…")
		).toBe("Cargando…");
		expect(
			runtime.translate(messageIdForLiteral("Loading"), {}, "Loading")
		).toBe("Cargando");
	});

	test("translates desktop shell and composer literals", () => {
		const runtime = new I18nRuntime([], {
			initialLocale: "de-DE",
			initialPackId: null,
		});
		const translate = (source: string) =>
			runtime.translate(messageIdForLiteral(source), {}, source);
		expect(translate("Close tabs to the right")).toBe("Tabs rechts schließen");
		expect(translate("Messages in this chat won't be saved.")).toBe(
			"Nachrichten in diesem Chat werden nicht gespeichert."
		);
		expect(translate("Regenerate reply")).toBe("Antwort neu generieren");
		expect(runtime.translate("settings.title", {}, "Settings")).toBe(
			"Einstellungen"
		);
	});

	test("keeps right-to-left packs scoped and reports their direction", () => {
		const runtime = new I18nRuntime([
			{
				baseLocale: "en",
				direction: "rtl",
				id: "community/hebrew",
				locale: "he",
				messages: { "common.install": "התקנה" },
				name: "Hebrew",
				schemaVersion: 1,
				version: "1.0.0",
			},
		]);
		runtime.selectPack("community/hebrew");
		expect(runtime.direction).toBe("rtl");
		expect(runtime.translate("common.install")).toBe("התקנה");
		expect(runtime.translate("common.cancel")).toBe("Cancel");
	});

	test("uses the caller's default message for an app-owned id", () => {
		const runtime = new I18nRuntime();
		expect(runtime.translate("my-app.refresh", {}, "Refresh this view")).toBe(
			"Refresh this view"
		);
		expect(runtime.getSnapshot()).toEqual({
			direction: "ltr",
			locale: "en",
			packId: null,
			packName: null,
			packVersion: null,
		});
	});

	test("protects app-owned placeholders with the caller's fallback", () => {
		const runtime = new I18nRuntime([
			{
				baseLocale: "en",
				direction: "ltr",
				id: "community/broken",
				locale: "en",
				messages: { "my-app.greeting": "Hi there" },
				name: "Broken placeholders",
				schemaVersion: 1,
				version: "1.0.0",
			},
		]);
		runtime.selectPack("community/broken");
		expect(
			runtime.translate("my-app.greeting", { name: "Ari" }, "Hello, {name}.")
		).toBe("Hello, Ari.");
	});

	test("supports a native persistence adapter", () => {
		const saved: (string | null)[] = [];
		const runtime = new I18nRuntime([], {
			initialPackId: null,
			persistPackId: (id) => {
				saved.push(id);
			},
		});
		runtime.selectPack("en-x-ryu-online");
		runtime.selectPack(null);
		expect(saved).toEqual(["en-x-ryu-online", null]);
	});

	test("remembers a disabled pack selection until its lifecycle is enabled", () => {
		const pack = {
			baseLocale: "en",
			direction: "ltr" as const,
			enabled: false,
			id: "community/later",
			locale: "en",
			messages: { "common.install": "Later" },
			name: "Later",
			schemaVersion: 1 as const,
			version: "1.0.0",
		};
		const runtime = new I18nRuntime([pack]);
		runtime.selectPack(pack.id);
		expect(runtime.selectedPack).toBeNull();
		runtime.setPacks([{ ...pack, enabled: true }]);
		expect(runtime.translate("common.install")).toBe("Later");
	});

	test("enforces the portable artifact byte limit", () => {
		const messages = Object.fromEntries(
			Array.from({ length: 160 }, (_, index) => [
				`message.${index}`,
				"x".repeat(30_000),
			])
		);
		const pack = {
			baseLocale: "en",
			direction: "ltr" as const,
			id: "large-pack",
			locale: "en",
			messages,
			name: "Large pack",
			schemaVersion: 1 as const,
			version: "1.0.0",
		};
		let serialized: string;
		try {
			serialized = JSON.stringify(pack);
		} catch {
			throw new Error("test fixture could not be serialized");
		}
		expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(
			MAX_LANGUAGE_PACK_BYTES
		);
		expect(() => parseLanguagePackJson(serialized)).toThrow(
			LanguagePackValidationError
		);
		expect(() => languagePackJson(pack)).toThrow(LanguagePackValidationError);
	});

	test("round-trips the data-only portable archive", () => {
		const pack = {
			baseLocale: "en",
			direction: "ltr" as const,
			id: "community/portable",
			locale: "en",
			messages: { "common.search": "Find" },
			name: "Portable",
			schemaVersion: 1 as const,
			version: "1.0.0",
		};
		expect(parseLanguagePackArchive(languagePackArchive(pack))).toEqual(pack);
	});

	test("rejects executable or unrelated archive entries", () => {
		const pack = {
			baseLocale: "en",
			direction: "ltr" as const,
			id: "community/portable",
			locale: "en",
			messages: { "common.search": "Find" },
			name: "Portable",
			schemaVersion: 1 as const,
			version: "1.0.0",
		};
		const archive = zipSync({
			"language-pack.json": strToU8(languagePackJson(pack)),
			"ryu.package.json": strToU8(
				`${JSON.stringify(languagePackPortableManifest(pack))}\n`
			),
			"payload.js": strToU8("throw new Error('must never run')"),
		});
		expect(() => parseLanguagePackArchive(archive)).toThrow(
			LanguagePackValidationError
		);
	});
});

describe("app message overlays", () => {
	const overlays = {
		es: { "Ripple mode": "Modo de arrastre", Export: "No gana" },
		"pt-BR": { "Ripple mode": "Modo ripple" },
	};

	test("an app literal follows the selected locale", () => {
		const runtime = new I18nRuntime([], {
			initialLocale: "es",
			initialPackId: null,
			overlays,
		});
		const id = messageIdForLiteral("Ripple mode");
		expect(runtime.overlayMessage(id)).toBe("Modo de arrastre");
		expect(runtime.translate(id, {}, "Ripple mode")).toBe("Modo de arrastre");
		runtime.setLocale("pt-BR");
		expect(runtime.translate(id, {}, "Ripple mode")).toBe("Modo ripple");
		runtime.setLocale("en");
		expect(runtime.overlayMessage(id)).toBeUndefined();
		expect(runtime.translate(id, {}, "Ripple mode")).toBe("Ripple mode");
	});

	test("the selected pack's own message wins over an overlay", () => {
		const runtime = new I18nRuntime([], {
			initialLocale: "es",
			initialPackId: null,
			overlays,
		});
		const exportId = messageIdForLiteral("Export");
		expect(runtime.translate(exportId, {}, "Export")).toBe(
			runtime.selectedPack?.messages[exportId] ?? "missing"
		);
		expect(runtime.translate(exportId, {}, "Export")).not.toBe("No gana");
	});

	test("replacing overlays notifies subscribers", () => {
		const runtime = new I18nRuntime([], {
			initialLocale: "fr",
			initialPackId: null,
		});
		let notified = 0;
		runtime.subscribe(() => {
			notified++;
		});
		const id = messageIdForLiteral("Ripple mode");
		expect(runtime.overlayMessage(id)).toBeUndefined();
		runtime.setOverlays({ fr: { "Ripple mode": "Mode ripple" } });
		expect(notified).toBe(1);
		expect(runtime.translate(id, {}, "Ripple mode")).toBe("Mode ripple");
	});
});
