import { afterEach, describe, expect, test } from "bun:test";
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import { messageIdForLiteral } from "../../../i18n/src/literal-catalog.ts";
import { errorMessage } from "./creator-errors.ts";

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

afterEach(() => {
	unregisterActiveI18nRuntime(japanese);
});

describe("creator errorMessage", () => {
	test("a browser fetch failure shows the translated network sentence", () => {
		registerActiveI18nRuntime(japanese);
		for (const message of ["Failed to fetch", "Load failed"]) {
			expect(errorMessage(new TypeError(message), "Fallback")).toBe(JAPANESE);
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
