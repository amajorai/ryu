import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	I18nRuntime,
	messageIdForLiteral,
	registerLiteralCatalogLoader,
} from "@ryu/i18n/core";
import {
	buildNativeShellCopy,
	type NativeShellTranslate,
} from "./native-copy.ts";

// The bare "View" source is the macOS View menu (the noun sense). Buttons and
// links that open something use their own whole messages ("View details",
// "View licenses", "View certificate"), so a German menu title never lands on
// a verb button and the menu never reads as an imperative.

const LANGUAGES = ["de", "fr", "it"] as const;

function catalog(language: string): Record<string, string> {
	return JSON.parse(
		readFileSync(
			new URL(
				`../../../../packages/i18n/locales/${language}.json`,
				import.meta.url
			),
			"utf8"
		)
	) as Record<string, string>;
}

function translatorFor(language: string): NativeShellTranslate {
	const messages = catalog(language);
	registerLiteralCatalogLoader((requested) =>
		requested.slice(0, 2) === language ? messages : null
	);
	const runtime = new I18nRuntime([], {
		initialLocale: language,
		initialPackId: null,
	});
	return (source, values) =>
		runtime.translate(messageIdForLiteral(source), values, source);
}

afterEach(() => registerLiteralCatalogLoader(null));

describe("native shell View menu", () => {
	for (const language of LANGUAGES) {
		test(`${language}: menu.view is the menu noun, not a verb button`, () => {
			const tl = translatorFor(language);
			const copy = buildNativeShellCopy(tl, language);
			const menuView = copy.labels["menu.view"];
			const messages = catalog(language);

			expect(menuView).toBe(messages.View);
			expect(menuView).not.toBe("View");
			expect(messages["View details"]).toBeDefined();
			expect(menuView).not.toBe(tl("View details"));
		});
	}
});
