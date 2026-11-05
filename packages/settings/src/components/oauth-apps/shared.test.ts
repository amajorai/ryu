import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { messageIdForLiteral } from "../../../../i18n/src/literal-catalog.ts";
import { errorMessage } from "./shared.ts";

const SENTENCE =
	"Couldn't reach the server. Check your connection and try again.";
const JAPANESE =
	"サーバーに接続できませんでした。接続を確認してもう一度お試しください。";

const japanese: ActiveI18nRuntime = {
	direction: "ltr",
	locale: "ja",
	translate: (id, _values, fallback) =>
		id === messageIdForLiteral(SENTENCE) ? JAPANESE : (fallback ?? id),
};

/** A runtime backed by the shipped `packages/i18n/locales/<locale>.json`. */
function shippedRuntime(locale: string): ActiveI18nRuntime {
	const catalog = JSON.parse(
		readFileSync(
			new URL(`../../../../i18n/locales/${locale}.json`, import.meta.url),
			"utf8"
		)
	) as Record<string, string>;
	const byId = new Map(
		Object.entries(catalog).map(([source, text]) => [
			messageIdForLiteral(source),
			text,
		])
	);
	return {
		direction: locale === "ar" ? "rtl" : "ltr",
		locale,
		translate: (id, _values, fallback) => byId.get(id) ?? fallback ?? id,
	};
}

let active: ActiveI18nRuntime = japanese;

afterEach(() => {
	unregisterActiveI18nRuntime(japanese);
	unregisterActiveI18nRuntime(active);
});

describe("OAuth apps errorMessage", () => {
	test("a browser fetch failure shows the translated network sentence", () => {
		registerActiveI18nRuntime(japanese);
		for (const message of ["Failed to fetch", "Load failed"]) {
			expect(errorMessage(new TypeError(message), "Fallback")).toBe(JAPANESE);
		}
	});

	test("the shipped ja, ar and de catalogs replace the browser's English", () => {
		for (const locale of ["ja", "ar", "de"]) {
			active = shippedRuntime(locale);
			registerActiveI18nRuntime(active);
			const text = errorMessage(new TypeError("Failed to fetch"), "Fallback");
			expect(text).not.toBe(SENTENCE);
			expect(text).not.toContain("Failed to fetch");
			expect(text).toBe(active.translate(messageIdForLiteral(SENTENCE)));
			unregisterActiveI18nRuntime(active);
		}
	});

	test("server messages pass through and non-errors use the fallback", () => {
		expect(errorMessage(new Error("Name taken"), "Fallback")).toBe(
			"Name taken"
		);
		expect(errorMessage(undefined, "Fallback")).toBe("Fallback");
		expect(errorMessage(null, "Fallback")).toBe("Fallback");
	});
});
