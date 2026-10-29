import { describe, expect, test } from "bun:test";

import { cliLocale } from "./locale.ts";
import { createCliTranslator } from "./translate.ts";

const GERMAN = {
	"Press r to retry": "Drücke r, um es erneut zu versuchen",
	Channels: "Kanäle",
	"{count} agents running": "{count} Agenten laufen",
};

describe("CLI locale", () => {
	test("follows RYU_LOCALE, then the POSIX locale variables", () => {
		expect(cliLocale({ RYU_LOCALE: "fr", LANG: "de_DE.UTF-8" })).toBe("fr");
		expect(cliLocale({ LC_ALL: "pt_BR.UTF-8", LANG: "de_DE" })).toBe("pt-BR");
		expect(cliLocale({ LANG: "de_AT.UTF-8@euro" })).toBe("de");
		expect(cliLocale({ LANG: "zh_CN.UTF-8" })).toBe("zh-CN");
	});

	test("stays English for C, POSIX, English and unsupported languages", () => {
		expect(cliLocale({})).toBeNull();
		expect(cliLocale({ LANG: "C.UTF-8" })).toBeNull();
		expect(cliLocale({ LC_ALL: "POSIX" })).toBeNull();
		expect(cliLocale({ LANG: "en_GB.UTF-8" })).toBeNull();
		expect(cliLocale({ LANG: "sv_SE.UTF-8" })).toBeNull();
	});
});

describe("CLI translator", () => {
	const german = createCliTranslator("de", GERMAN);

	test("translates known literals and keeps JSX whitespace", () => {
		expect(german.tr("Channels")).toBe("Kanäle");
		expect(german.tr(" Channels ")).toBe(" Kanäle ");
		expect(german.tr("my-project")).toBe("my-project");
	});

	test("translates children and copy props, never other props", () => {
		const props = german.translateProps({
			children: ["Channels", 3, " Press r to retry"],
			id: "Channels",
			title: "Channels",
		});
		expect(props).toEqual({
			children: ["Kanäle", 3, " Drücke r, um es erneut zu versuchen"],
			id: "Channels",
			title: "Kanäle",
		});
	});

	test("formats ICU messages in the target language", () => {
		expect(german.tf("{count} agents running", { count: 2 })).toBe(
			"2 Agenten laufen"
		);
	});

	test("is a no-op in English", () => {
		const english = createCliTranslator(null, null);
		const props = { children: "Channels" };
		expect(english.translateProps(props)).toBe(props);
		expect(english.tf("{count} agents running", { count: 2 })).toBe(
			"2 agents running"
		);
	});
});
