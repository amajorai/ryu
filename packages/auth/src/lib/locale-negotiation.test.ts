import { describe, expect, it } from "bun:test";
import {
	acceptLanguageTags,
	cookieValue,
	matchAvailableLocale,
	negotiateRequestLocale,
} from "./locale-negotiation.ts";

// The shape of Better Auth's dictionary keys: bare languages.
const BETTER_AUTH_KEYS = ["ar", "de", "en", "fr", "ja", "nl", "pt", "zh"];
// The app's official catalog locales plus English.
const APP_LOCALES = [
	"ar",
	"de",
	"en",
	"es",
	"fr",
	"hi",
	"it",
	"ja",
	"ko",
	"pt-BR",
	"ru",
	"zh-CN",
];

describe("matchAvailableLocale", () => {
	it("maps every regional app locale onto a bare dictionary key", () => {
		expect(matchAvailableLocale("pt-BR", BETTER_AUTH_KEYS)).toBe("pt");
		expect(matchAvailableLocale("pt-br", BETTER_AUTH_KEYS)).toBe("pt");
		expect(matchAvailableLocale("zh-CN", BETTER_AUTH_KEYS)).toBe("zh");
		expect(matchAvailableLocale("zh-Hans", BETTER_AUTH_KEYS)).toBe("zh");
		expect(matchAvailableLocale("pt_BR", BETTER_AUTH_KEYS)).toBe("pt");
		expect(matchAvailableLocale("fr-CA", BETTER_AUTH_KEYS)).toBe("fr");
		expect(matchAvailableLocale("en-GB", BETTER_AUTH_KEYS)).toBe("en");
	});

	it("keeps exact matches and non-official dictionary languages", () => {
		expect(matchAvailableLocale("de", BETTER_AUTH_KEYS)).toBe("de");
		expect(matchAvailableLocale("nl", BETTER_AUTH_KEYS)).toBe("nl");
		expect(matchAvailableLocale("PT-BR", APP_LOCALES)).toBe("pt-BR");
	});

	it("maps bare languages onto regional keys", () => {
		expect(matchAvailableLocale("pt", APP_LOCALES)).toBe("pt-BR");
		expect(matchAvailableLocale("pt-PT", APP_LOCALES)).toBe("pt-BR");
		expect(matchAvailableLocale("zh", APP_LOCALES)).toBe("zh-CN");
	});

	it("does not serve Traditional Chinese from a Simplified dictionary", () => {
		expect(matchAvailableLocale("zh-TW", BETTER_AUTH_KEYS)).toBeNull();
		expect(matchAvailableLocale("zh-Hant", APP_LOCALES)).toBeNull();
	});

	it("rejects empty, malformed and uncovered tags", () => {
		expect(matchAvailableLocale(null, BETTER_AUTH_KEYS)).toBeNull();
		expect(matchAvailableLocale("  ", BETTER_AUTH_KEYS)).toBeNull();
		expect(matchAvailableLocale("not a tag!", BETTER_AUTH_KEYS)).toBeNull();
		expect(matchAvailableLocale("sw", BETTER_AUTH_KEYS)).toBeNull();
	});
});

describe("acceptLanguageTags", () => {
	it("orders by quality, keeping header order for ties", () => {
		expect(
			acceptLanguageTags("fr;q=0.5, pt-BR, *;q=0.1, de;q=0.5, ja;q=0")
		).toEqual(["pt-BR", "fr", "de"]);
	});

	it("handles an empty header", () => {
		expect(acceptLanguageTags(null)).toEqual([]);
		expect(acceptLanguageTags("")).toEqual([]);
	});
});

describe("cookieValue", () => {
	it("reads and decodes one cookie", () => {
		expect(cookieValue("a=1; locale=pt%2DBR", "locale")).toBe("pt-BR");
		expect(cookieValue("a=1", "locale")).toBeNull();
		expect(cookieValue("locale=%E0%A4%A", "locale")).toBeNull();
	});
});

describe("negotiateRequestLocale", () => {
	const negotiate = (init: Record<string, string>) =>
		negotiateRequestLocale({
			available: BETTER_AUTH_KEYS,
			headers: new Headers(init),
			localeCookie: "locale",
		});

	it("prefers the cookie, mapped onto the dictionary", () => {
		expect(negotiate({ cookie: "locale=pt-BR", "accept-language": "de" })).toBe(
			"pt"
		);
		expect(negotiate({ cookie: "locale=zh-CN", "accept-language": "de" })).toBe(
			"zh"
		);
	});

	it("falls back to the best covered Accept-Language entry", () => {
		expect(
			negotiate({ cookie: "locale=sw", "accept-language": "sw, ja;q=0.8" })
		).toBe("ja");
		expect(negotiate({ "accept-language": "zh-TW, zh-CN;q=0.5" })).toBe("zh");
	});

	it("puts the stored locale between the cookie and the header", () => {
		const withStored = (init: Record<string, string>, stored: unknown) =>
			negotiateRequestLocale({
				available: BETTER_AUTH_KEYS,
				headers: new Headers(init),
				localeCookie: "locale",
				stored,
			});
		expect(withStored({ "accept-language": "de" }, "pt-BR")).toBe("pt");
		expect(
			withStored({ cookie: "locale=ja", "accept-language": "de" }, "pt-BR")
		).toBe("ja");
		expect(withStored({ "accept-language": "de" }, "zh-TW")).toBe("de");
		expect(withStored({ "accept-language": "de" }, 42)).toBe("de");
		expect(
			negotiateRequestLocale({
				available: BETTER_AUTH_KEYS,
				headers: null,
				localeCookie: "locale",
				stored: "zh-CN",
			})
		).toBe("zh");
	});

	it("returns null when nothing matches", () => {
		expect(negotiate({ "accept-language": "sw" })).toBeNull();
		expect(
			negotiateRequestLocale({
				available: BETTER_AUTH_KEYS,
				headers: null,
				localeCookie: "locale",
			})
		).toBeNull();
	});
});
