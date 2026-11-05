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

// The bare "Window" source names the OS window (the macOS Window menu, the
// OS-desktop menubar, an untitled captured window). Time-period labels use
// their own "Time window" source, so the two meanings never share one
// translation and the native menu never reads "Period".

const LANGUAGES = ["de", "ja", "ar"] as const;

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

describe("native shell Window menu", () => {
	for (const language of LANGUAGES) {
		test(`${language}: menu.window is the OS-window term, not the time window`, () => {
			const tl = translatorFor(language);
			const copy = buildNativeShellCopy(tl, language);
			const menuWindow = copy.labels["menu.window"];
			const messages = catalog(language);

			expect(menuWindow).toBe(messages.Window);
			expect(menuWindow).not.toBe("Window");
			expect(messages["Time window"]).toBeDefined();
			expect(menuWindow).not.toBe(tl("Time window"));
		});
	}
});
