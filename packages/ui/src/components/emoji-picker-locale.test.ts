import { describe, expect, test } from "bun:test";
import {
	type EmojiMartLocale,
	emojiMartI18nLoader,
	emojiMartLocale,
	emojiMartLocaleProps,
} from "./emoji-picker-locale.ts";

describe("emojiMartLocale", () => {
	test.each<[string, EmojiMartLocale]>([
		["en", "en"],
		["es", "es"],
		["fr", "fr"],
		["de", "de"],
		["pt-BR", "pt"],
		["ja", "ja"],
		["zh-CN", "zh"],
		["it", "it"],
		["ko", "ko"],
		["hi", "hi"],
		["ru", "ru"],
		["ar", "ar"],
	])("maps the official %s pack to %s", (locale, code) => {
		expect(emojiMartLocale(locale)).toBe(code);
	});

	test("falls back to English for languages EmojiMart does not translate", () => {
		expect(emojiMartLocale("sv")).toBe("en");
		expect(emojiMartLocale("")).toBe("en");
		expect(emojiMartLocale("en-GB")).toBe("en");
	});
});

describe("emojiMartI18nLoader", () => {
	test("keeps EmojiMart's built-in English without a loader", () => {
		expect(emojiMartI18nLoader("en")).toBeUndefined();
	});

	test("lazily loads the picker strings for ja", async () => {
		const props = emojiMartLocaleProps("ja");
		expect(props.locale).toBe("ja");
		const strings = await props.i18n?.();
		expect(strings?.search).toBe("検索");
	});

	test("loads right-to-left strings for ar", async () => {
		const strings = await emojiMartI18nLoader("ar")?.();
		expect(strings?.rtl).toBe(true);
	});
});
