import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as coreModule from "@ryu/i18n/core";
import { messageIdForLiteral } from "@ryu/i18n/core";
import {
	createNativeCopyTranslator,
	type NativeCopyI18n,
} from "./native-copy-translator.ts";

const KNOWN = "Your agent needs approval";
const KNOWN_ID = messageIdForLiteral(KNOWN);

function fakeI18n(messages: Record<string, string>): NativeCopyI18n {
	return {
		availablePacks: [],
		hasOverlayMessage: (id) => Object.hasOwn(messages, id),
		t: (id, _values, fallback) => messages[id] ?? fallback,
	};
}

describe("createNativeCopyTranslator", () => {
	test("translates a known first-party literal", () => {
		const translate = createNativeCopyTranslator(
			fakeI18n({ [KNOWN_ID]: "Votre agent attend une approbation" }),
			false
		);
		expect(translate(KNOWN)).toBe("Votre agent attend une approbation");
	});

	test("swaps bot terms only on known literals", () => {
		const translate = createNativeCopyTranslator(
			fakeI18n({ [KNOWN_ID]: KNOWN }),
			true
		);
		expect(translate(KNOWN)).toBe("Your bot needs approval");
		expect(translate("Sales Agent")).toBe("Sales Agent");
		expect(translate("the agent replied")).toBe("the agent replied");
	});

	test("without i18n, unknown text is untouched even with bot terms on", () => {
		const translate = createNativeCopyTranslator(null, true);
		expect(translate("Sales Agent")).toBe("Sales Agent");
	});

	test("pack messages count as known literals", () => {
		const translate = createNativeCopyTranslator(
			{
				availablePacks: [{ messages: { [KNOWN_ID]: "Pack copy" } }],
				hasOverlayMessage: () => false,
				t: (_id, _values, fallback) => `T:${fallback}`,
			},
			false
		);
		expect(translate(KNOWN)).toBe(`T:${KNOWN}`);
		expect(translate("Agent Smith")).toBe("Agent Smith");
	});

	test("a dynamic sentence translates through a catalog template", () => {
		const calls: string[] = [];
		const translate = createNativeCopyTranslator(
			{
				...fakeI18n({}),
				templateMessage: (text) => {
					calls.push(text);
					return text === "Changed from $10 to $8."
						? "Geändert von $10 auf $8."
						: undefined;
				},
			},
			false
		);
		expect(translate("Changed from $10 to $8.")).toBe(
			"Geändert von $10 auf $8."
		);
		// No template matches runtime prose: it passes through unchanged.
		expect(translate("Sales Agent")).toBe("Sales Agent");
		expect(calls).toEqual(["Changed from $10 to $8.", "Sales Agent"]);
	});

	test("an exact literal wins over a template", () => {
		const translate = createNativeCopyTranslator(
			{
				...fakeI18n({ [KNOWN_ID]: "Exact" }),
				templateMessage: () => "Template",
			},
			false
		);
		expect(translate(KNOWN)).toBe("Exact");
	});
});

describe("createNativeCopyTranslator with the real catalogs", () => {
	const { I18nRuntime, registerLiteralCatalogLoader } = coreModule;
	const catalogs = new Map<string, Record<string, string>>();
	function catalog(language: string): Record<string, string> {
		const cached = catalogs.get(language);
		if (cached) {
			return cached;
		}
		const loaded = JSON.parse(
			readFileSync(
				new URL(
					`../../../../packages/i18n/locales/${language}.json`,
					import.meta.url
				),
				"utf8"
			)
		) as Record<string, string>;
		catalogs.set(language, loaded);
		return loaded;
	}

	afterEach(() => registerLiteralCatalogLoader(null));

	function translatorFor(locale: string) {
		registerLiteralCatalogLoader((requested) =>
			["de", "ja", "ar"].includes(requested.slice(0, 2))
				? catalog(requested.slice(0, 2))
				: null
		);
		const runtime = new I18nRuntime([], {
			initialLocale: locale,
			initialPackId: null,
		});
		return createNativeCopyTranslator(
			{
				availablePacks: runtime.availablePacks,
				hasOverlayMessage: (id) => runtime.overlayMessage(id) !== undefined,
				t: (id, values, fallback) => runtime.translate(id, values, fallback),
				templateMessage: (text) => runtime.templateMessage(text),
			},
			false
		);
	}

	const SOURCES = [
		"Site down",
		"Unexpected HTTP 503.",
		"Changed from $10 to $8.",
	];
	const EXPECTED: Record<string, [string, string, string]> = {
		de: [
			"Website nicht erreichbar",
			"Unerwarteter HTTP-Status 503.",
			"Von $10 auf $8 geändert.",
		],
		ja: [
			"サイトがダウンしています",
			"予期しない HTTP 503 です。",
			"$10 から $8 に変わりました。",
		],
		ar: ["الموقع متوقف", "استجابة HTTP 503 غير متوقعة.", "تغيّر من $10 إلى $8."],
	};

	for (const [locale, expected] of Object.entries(EXPECTED)) {
		test(`monitor alert copy renders in ${locale}`, () => {
			const translate = translatorFor(locale);
			expect(SOURCES.map(translate)).toEqual(expected);
			// Runtime data that matches no template stays as written.
			expect(translate("Acme storefront")).toBe("Acme storefront");
		});
	}

	test("English output is unchanged", () => {
		const translate = translatorFor("en");
		expect(translate("Unexpected HTTP 503.")).toBe("Unexpected HTTP 503.");
		expect(translate("Changed from $10 to $8.")).toBe(
			"Changed from $10 to $8."
		);
	});
});
