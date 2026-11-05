import { describe, expect, test } from "bun:test";
import {
	EN_NATIVE_MENU_MESSAGES,
	OFFICIAL_NATIVE_MENU_MESSAGES,
	withNativeMenuMessages,
} from "./en-messages-native-menu.ts";
import { OFFICIAL_LANGUAGE_PACKS } from "./locales.ts";
import { BUILT_IN_LANGUAGE_PACKS } from "./messages.ts";
import type { LanguagePack } from "./pack.ts";

const ids = Object.keys(EN_NATIVE_MENU_MESSAGES).sort();

function builtIn(locale: string): LanguagePack {
	const pack = BUILT_IN_LANGUAGE_PACKS.find((entry) => entry.locale === locale);
	if (!pack) {
		throw new Error(`no built-in pack for ${locale}`);
	}
	return pack;
}

describe("native menu messages", () => {
	test("every official non-English pack carries both menu ids", () => {
		for (const pack of OFFICIAL_LANGUAGE_PACKS) {
			const terms = OFFICIAL_NATIVE_MENU_MESSAGES[pack.locale];
			expect(terms && Object.keys(terms).sort()).toEqual(ids);
			for (const id of ids) {
				expect(builtIn(pack.locale).messages[id]?.trim()).toBeTruthy();
			}
		}
	});

	test("the menu noun is separate from the Edit button verb", () => {
		const french = builtIn("fr").messages;
		expect(french["nativeMenu.edit"]).toBe("Édition");
		expect(french["common.edit"]).not.toBe("Édition");
		const russian = builtIn("ru").messages;
		expect(russian["nativeMenu.edit"]).toBe("Правка");
		expect(russian["nativeMenu.zoom"]).toBe("Изменить масштаб");
		expect(builtIn("ja").messages["nativeMenu.zoom"]).toBe("拡大/縮小");
		expect(builtIn("ar").messages["nativeMenu.edit"]).toBe("تحرير");
	});

	test("English sources stay the plain menu titles", () => {
		expect(EN_NATIVE_MENU_MESSAGES).toEqual({
			"nativeMenu.edit": "Edit",
			"nativeMenu.zoom": "Zoom",
		});
	});

	test("a pack for a locale without menu terms is returned unchanged", () => {
		const community: LanguagePack = {
			baseLocale: "en",
			direction: "ltr",
			id: "community-xx",
			locale: "xx",
			messages: { "common.edit": "Edit-xx" },
			name: "Example",
			schemaVersion: 1,
			version: "1.0.0",
		};
		expect(withNativeMenuMessages(community)).toBe(community);
	});
});
