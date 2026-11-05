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
	type NativeShellTranslateId,
} from "./native-copy.ts";

// The macOS Edit menu and Window ▸ Zoom use their own ids (`nativeMenu.*`), so
// the menu bar shows the platform's menu noun ("Édition", "Правка") instead of
// the Edit-button verb ("Modifier", "Изменить"), and Zoom reads as maximise.

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

function translatorsFor(
	language: string
): [NativeShellTranslate, NativeShellTranslateId] {
	const messages = catalog(language);
	registerLiteralCatalogLoader((requested) =>
		requested.slice(0, 2) === language ? messages : null
	);
	const runtime = new I18nRuntime([], {
		initialLocale: language,
		initialPackId: null,
	});
	return [
		(source, values) =>
			runtime.translate(messageIdForLiteral(source), values, source),
		(id, source) => runtime.translate(id, {}, source),
	];
}

afterEach(() => registerLiteralCatalogLoader(null));

const EXPECTED = [
	["fr", "Édition", "Réduire/agrandir"],
	["ru", "Правка", "Изменить масштаб"],
	["ar", "تحرير", "تكبير/تصغير"],
	["hi", "संपादन", "ज़ूम करें"],
	["it", "Composizione", "Zoom"],
] as const;

// Locales whose Edit menu and Edit button already share a word: the menu id
// still resolves to the platform term, and Zoom gets the window sense.
const SHARED_EDIT = [
	["ja", "編集", "拡大/縮小"],
	["de", "Bearbeiten", "Zoomen"],
	["ko", "편집", "확대/축소"],
	["zh-CN", "编辑", "缩放"],
	["es", "Edición", "Zoom"],
	["pt-BR", "Editar", "Zoom"],
] as const;

describe("native shell Edit and Zoom menu items", () => {
	for (const [language, edit, zoom] of EXPECTED) {
		test(`${language}: menu.edit is the menu noun and menu.zoom maximises`, () => {
			const [tl, tid] = translatorsFor(language);
			const copy = buildNativeShellCopy(tl, language, tid);

			expect(copy.labels["menu.edit"]).toBe(edit);
			expect(copy.labels["menu.zoom"]).toBe(zoom);
			// The Edit button keeps its verb; only the menu title changed.
			expect(tl("Edit")).not.toBe(edit);
		});
	}

	for (const [language, edit, zoom] of SHARED_EDIT) {
		test(`${language}: menu titles use the platform menu terms`, () => {
			const [tl, tid] = translatorsFor(language);
			const copy = buildNativeShellCopy(tl, language, tid);
			expect(copy.labels["menu.edit"]).toBe(edit);
			expect(copy.labels["menu.zoom"]).toBe(zoom);
			// Neighbouring menu items still come from the literal catalog.
			expect(copy.labels["menu.undo"]).toBe(tl("Undo"));
		});
	}

	test("en keeps the English titles", () => {
		const [tl, tid] = translatorsFor("en");
		const copy = buildNativeShellCopy(tl, "en", tid);
		expect(copy.labels["menu.edit"]).toBe("Edit");
		expect(copy.labels["menu.zoom"]).toBe("Zoom");
	});

	test("without an id translator the literal sources are used", () => {
		const copy = buildNativeShellCopy((source) => `[${source}]`, "en");
		expect(copy.labels["menu.edit"]).toBe("[Edit]");
		expect(copy.labels["menu.zoom"]).toBe("[Zoom]");
	});
});
