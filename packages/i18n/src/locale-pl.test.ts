import { describe, expect, test } from "bun:test";
import { I18nRuntime } from "./core.ts";
import { EN_MESSAGES } from "./en-messages.ts";
import { OFFICIAL_SENSE_MESSAGES } from "./en-messages-senses.ts";
import { POLISH_SENSE_MESSAGES_BASE } from "./en-messages-senses-pl.ts";
import { placeholderNames } from "./icu-syntax.ts";
import { REPEATED_LITERAL_TRANSLATIONS } from "./literal-translations.ts";
import { POLISH_LANGUAGE_PACK } from "./locale-pl.ts";
import { polishLiteralMessages } from "./locale-pl-literals.ts";
import { POLISH_LOGIN_MESSAGES } from "./locale-pl-login.ts";
import { POLISH_MESSAGES_A } from "./locale-pl-messages-a.ts";
import { POLISH_MESSAGES_B } from "./locale-pl-messages-b.ts";
import { OFFICIAL_LANGUAGE_PACKS } from "./locales.ts";
import { literalMessageId } from "./message-id.ts";
import { BUILT_IN_LANGUAGE_PACKS } from "./messages.ts";
import { ALL_OFFICIAL_LANGUAGE_PACKS } from "./official-language-packs.ts";

const polish = BUILT_IN_LANGUAGE_PACKS.find((pack) => pack.locale === "pl");
const PLURAL_HEAD = /,\s*plural\s*,/u;
const HAS_ONE_ARM = /\bone \{/u;

describe("official Polish pack", () => {
	test("is listed after the packs of locales.ts and built in", () => {
		expect(ALL_OFFICIAL_LANGUAGE_PACKS.map((pack) => pack.id)).toEqual([
			...OFFICIAL_LANGUAGE_PACKS.map((pack) => pack.id),
			"official/pl",
		]);
		expect(polish?.id).toBe("official/pl");
		expect(polish?.direction).toBe("ltr");
		expect(polish?.name).toBe("Polski");
	});

	test("covers the same ids as every other official pack", () => {
		const spanish = BUILT_IN_LANGUAGE_PACKS.find(
			(pack) => pack.locale === "es"
		);
		expect(Object.keys(polish?.messages ?? {}).sort()).toEqual(
			Object.keys(spanish?.messages ?? {}).sort()
		);
	});

	test("the parts do not overlap and keep each source's placeholders", () => {
		const parts = [POLISH_MESSAGES_A, POLISH_MESSAGES_B, POLISH_LOGIN_MESSAGES];
		const ids = parts.flatMap((part) => Object.keys(part));
		expect(new Set(ids).size).toBe(ids.length);
		for (const [id, value] of Object.entries(POLISH_LANGUAGE_PACK.messages)) {
			const source = (EN_MESSAGES as Record<string, string>)[id];
			if (source !== undefined) {
				expect(placeholderNames(value)).toEqual(placeholderNames(source));
			}
			expect(value.trim()).not.toBe("");
			expect(value).not.toContain("—");
		}
	});

	test("translates every repeated literal by its literal id", () => {
		const literals = polishLiteralMessages();
		expect(Object.keys(literals).sort()).toEqual(
			Object.keys(REPEATED_LITERAL_TRANSLATIONS)
				.map((source) => literalMessageId(source))
				.sort()
		);
		expect(literals[literalMessageId("Close tab")]).toBe("Zamknij kartę");
	});

	test("carries the base senses in the sense table", () => {
		expect(OFFICIAL_SENSE_MESSAGES.pl?.["mail.recipientTo"]).toBe(
			POLISH_SENSE_MESSAGES_BASE["mail.recipientTo"]
		);
		expect(polish?.messages["mail.recipientTo"]).toBe("Do");
		expect(polish?.messages["nativeMenu.edit"]).toBe("Edycja");
	});

	test("every counted message has the four Polish plural forms", () => {
		for (const [id, value] of Object.entries(POLISH_LANGUAGE_PACK.messages)) {
			if (PLURAL_HEAD.test(value) && HAS_ONE_ARM.test(value)) {
				for (const arm of ["few {", "many {", "other {"]) {
					expect(`${id}: ${value}`).toContain(arm);
				}
			}
		}
	});

	test("picks one, few, many and other by count", () => {
		const runtime = new I18nRuntime([], { initialPackId: "official/pl" });
		const documents = (count: number) =>
			runtime.translate("extension.spaces.document-count", { count });
		expect(documents(1)).toBe("1 dokument");
		expect(documents(3)).toBe("3 dokumenty");
		expect(documents(5)).toBe("5 dokumentów");
		expect(documents(22)).toBe("22 dokumenty");
		expect(documents(112)).toBe("112 dokumentów");
		expect(documents(1.5)).toBe("1,5 dokumentu");
		expect(runtime.translate("language.translation_count", { count: 0 })).toBe(
			"Brak przetłumaczonych ciągów"
		);
	});

	test("a Polish system locale selects the pack", () => {
		const runtime = new I18nRuntime([], {
			initialLocale: "pl-PL",
			initialPackId: null,
		});
		expect(runtime.selectedPackId).toBe("official/pl");
		expect(runtime.direction).toBe("ltr");
		expect(runtime.translate("common.cancel")).toBe("Anuluj");
	});
});
