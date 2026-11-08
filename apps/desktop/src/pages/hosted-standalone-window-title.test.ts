import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import ar from "../../../../packages/i18n/locales/ar.json" with {
	type: "json",
};
import de from "../../../../packages/i18n/locales/de.json" with {
	type: "json",
};
import ja from "../../../../packages/i18n/locales/ja.json" with {
	type: "json",
};
import {
	standaloneWindowTitle,
	translatedAppName,
} from "./hosted-standalone-window-title.ts";

function literalMessages(catalog: Record<string, string>): LiteralMessage {
	return (source) => catalog[source] ?? source;
}

const japanese = literalMessages({
	Forms: "フォーム",
	"Safe Actions": "セーフアクション",
});

describe("standalone window title", () => {
	test("translates the companion label under ja", () => {
		expect(standaloneWindowTitle(japanese, { label: "Forms" })).toBe(
			"フォーム"
		);
	});

	test("falls back to the manifest name when there is no label", () => {
		expect(
			standaloneWindowTitle(japanese, { label: "", name: "Safe Actions" })
		).toBe("セーフアクション");
	});

	test("passes brand names through unchanged", () => {
		expect(standaloneWindowTitle(japanese, { name: "Ryu Browser" })).toBe(
			"Ryu Browser"
		);
	});

	test("leaves the opened title alone until the companion resolves", () => {
		expect(standaloneWindowTitle(japanese, undefined)).toBeUndefined();
		expect(standaloneWindowTitle(japanese, { label: "", name: "" })).toBe(
			undefined
		);
	});
});

/** Like the runtime: a catalog hit wins, unknown copy is ICU-formatted. */
function shippedCatalog(
	catalog: Record<string, string>,
	locale: string
): LiteralMessage {
	return (source, values) =>
		catalog[source] ?? formatMessage(source, values ?? {}, locale);
}

describe("standalone window title with the shipped catalogs", () => {
	test.each([
		["ja", ja, "フォーム"],
		["ar", ar, "النماذج"],
		["de", de, "Formulare"],
	])("translates an app label under %s", (locale, catalog, expected) => {
		const tl = shippedCatalog(catalog as Record<string, string>, locale);
		expect(standaloneWindowTitle(tl, { label: "Forms" })).toBe(expected);
		expect(translatedAppName(tl, "Forms")).toBe(expected);
	});

	test("keeps English unchanged and shows braced names verbatim", () => {
		const english = shippedCatalog({}, "en");
		expect(standaloneWindowTitle(english, { label: "Forms" })).toBe("Forms");
		expect(translatedAppName(english, "Ryu {Lab}")).toBe("Ryu {Lab}");
		expect(
			standaloneWindowTitle(shippedCatalog(ja, "ja"), { name: "Ryu {Lab}" })
		).toBe("Ryu {Lab}");
	});
});
