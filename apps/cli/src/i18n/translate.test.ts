import { describe, expect, test } from "bun:test";

import { errorToJson, formatError } from "../cli/output.ts";
import { UsageError } from "../cli/types.ts";
import {
	formatCliDate,
	formatCliDateTime,
	formatCliElapsed,
	formatCliNumber,
} from "./format.ts";
import { cliLocale, cliLocales } from "./locale.ts";
import { createCliTranslator } from "./translate.ts";

const GERMAN = {
	"Press r to retry": "Drücke r, um es erneut zu versuchen",
	Channels: "Kanäle",
	"{count} agents running": "{count} Agenten laufen",
};

const NO_OS = "und";

describe("CLI locale", () => {
	test("follows RYU_LOCALE, then the POSIX locale variables", () => {
		expect(cliLocale({ RYU_LOCALE: "fr", LANG: "de_DE.UTF-8" }, NO_OS)).toBe(
			"fr"
		);
		expect(cliLocale({ LC_ALL: "pt_BR.UTF-8", LANG: "de_DE" }, NO_OS)).toBe(
			"pt-BR"
		);
		expect(cliLocale({ LANG: "de_AT.UTF-8@euro" }, NO_OS)).toBe("de");
		expect(cliLocale({ LANG: "zh_CN.UTF-8" }, NO_OS)).toBe("zh-CN");
	});

	test("stays English for C, POSIX, English and unsupported languages", () => {
		expect(cliLocale({}, NO_OS)).toBeNull();
		expect(cliLocale({ LANG: "C.UTF-8" }, "ja-JP")).toBeNull();
		expect(cliLocale({ LC_ALL: "POSIX" }, "ja-JP")).toBeNull();
		expect(cliLocale({ LANG: "en_GB.UTF-8" }, "ja-JP")).toBeNull();
		expect(cliLocale({ LANG: "sv_SE.UTF-8" }, NO_OS)).toBeNull();
		expect(
			cliLocale({ RYU_LOCALE: "en", LANG: "de_DE.UTF-8" }, NO_OS)
		).toBeNull();
	});

	test("honors the GNU LANGUAGE list before the POSIX variables", () => {
		expect(cliLocale({ LANGUAGE: "ja:en", LANG: "C.UTF-8" }, NO_OS)).toBe("ja");
		expect(
			cliLocale({ LANGUAGE: "sv:de:en", LANG: "fr_FR.UTF-8" }, NO_OS)
		).toBe("de");
		expect(
			cliLocale({ LANGUAGE: "en:de", LANG: "fr_FR.UTF-8" }, NO_OS)
		).toBeNull();
		expect(cliLocale({ LANGUAGE: "sv:nb", LANG: "fr_FR.UTF-8" }, NO_OS)).toBe(
			"fr"
		);
		expect(cliLocale({ LANGUAGE: "ja", RYU_LOCALE: "ko" }, NO_OS)).toBe("ko");
	});

	test("ignores LANGUAGE under a bare C or POSIX locale", () => {
		expect(cliLocale({ LANGUAGE: "ja", LANG: "C" }, NO_OS)).toBeNull();
		expect(cliLocale({ LANGUAGE: "ja", LC_ALL: "POSIX" }, NO_OS)).toBeNull();
	});

	test("resolves Arabic and Japanese environments end to end", () => {
		expect(cliLocales({ LANG: "ar_EG.UTF-8" }, NO_OS)).toEqual({
			format: "ar-EG",
			messages: "ar",
		});
		expect(cliLocales({}, "ja-JP")).toEqual({
			format: "ja-JP",
			messages: "ja",
		});
		expect(cliLocales({ LANGUAGE: "ar:en", LANG: "C.UTF-8" }, NO_OS)).toEqual({
			format: "ar",
			messages: "ar",
		});
	});

	test("falls back to the OS locale when no variable is set (Windows)", () => {
		expect(cliLocale({}, "ja-JP")).toBe("ja");
		expect(cliLocale({}, "de-CH")).toBe("de");
		expect(cliLocale({}, "en-US-u-va-posix")).toBeNull();
		expect(cliLocale({}, "und")).toBeNull();
		expect(cliLocale({ LANG: "fr_FR.UTF-8" }, "ja-JP")).toBe("fr");
	});

	test("formats in the environment's locale even without a catalog", () => {
		expect(cliLocales({ LANG: "en_GB.UTF-8" }, NO_OS)).toEqual({
			format: "en-GB",
			messages: null,
		});
		expect(cliLocales({ LANG: "sv_SE.UTF-8" }, NO_OS)).toEqual({
			format: "sv-SE",
			messages: null,
		});
		expect(cliLocales({ LANG: "de_AT.UTF-8" }, NO_OS)).toEqual({
			format: "de-AT",
			messages: "de",
		});
		expect(cliLocales({ LANG: "C.UTF-8" }, "ja-JP")).toEqual({
			format: "en",
			messages: null,
		});
	});
});

describe("CLI formatting", () => {
	const moment = Date.UTC(2026, 9, 31, 12, 0, 0);

	test("formats dates and numbers in the given locale", () => {
		expect(formatCliDate(moment, "de")).toBe(
			new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(moment)
		);
		expect(formatCliDate(moment, "en")).toContain("2026");
		expect(formatCliDateTime(moment, "ja")).toBe(
			new Intl.DateTimeFormat("ja", {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(moment)
		);
		expect(formatCliDate("not a date", "en")).toBeNull();
		expect(formatCliNumber(8192, undefined, "de")).toBe("8.192");
		expect(formatCliNumber(8192, undefined, "en")).toBe("8,192");
	});

	test("formats elapsed time compactly", () => {
		expect(formatCliElapsed(42, { milliseconds: true }, "en")).toBe("42ms");
		expect(formatCliElapsed(4200, {}, "en")).toBe("4.2s");
		expect(formatCliElapsed(65_000, {}, "en")).toBe("1m 5s");
		expect(formatCliElapsed(4200, {}, "de")).toContain("4,2");
		expect(formatCliElapsed(65_000, {}, "ja")).toContain("5");
		expect(formatCliNumber(8192, undefined, "ar-EG")).toBe(
			new Intl.NumberFormat("ar-EG").format(8192)
		);
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

	test("selects plural categories in Arabic and Japanese", () => {
		const message = "{count, plural, one {# file} other {# files}}";
		const arabic = createCliTranslator("ar", {
			[message]:
				"{count, plural, zero {لا ملفات} one {ملف واحد} two {ملفان} few {# ملفات} many {# ملفًا} other {# ملف}}",
		});
		expect(arabic.tf(message, { count: 0 })).toBe("لا ملفات");
		expect(arabic.tf(message, { count: 2 })).toBe("ملفان");
		expect(arabic.tf(message, { count: 3 })).toContain("ملفات");
		expect(arabic.tf(message, { count: 11 })).toContain("ملفًا");
		const japanese = createCliTranslator("ja", {
			[message]: "{count, plural, other {# 件のファイル}}",
		});
		expect(japanese.tf(message, { count: 1 })).toBe("1 件のファイル");
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

describe("CLI translator lookups for aligned copy and thrown messages", () => {
	const RELIABLE = "Reliable {rate}% over 7 days, p50 {p50} ms, p95 {p95} ms";
	const DURATION =
		"Invalid duration '{value}'. Use seconds or a suffix: 90m, 12h, 30d, 2w.";
	const DURATION_ERROR =
		"Invalid duration '5x'. Use seconds or a suffix: 90m, 12h, 30d, 2w.";
	const german = createCliTranslator("de", {
		[RELIABLE]:
			"Zuverlässigkeit {rate} % über 7 Tage, p50 {p50} ms, p95 {p95} ms",
		"Press r to retry": "Drücke r, um es erneut zu versuchen",
	});
	const japanese = createCliTranslator("ja", {
		[DURATION]:
			"期間「{value}」が無効です。秒数またはサフィックスを使用してください: 90m、12h、30d、2w。",
		"Channels are offline.": "チャネルはオフラインです。",
	});

	test("finds a whitespace-aligned source under its collapsed key", () => {
		expect(
			german.tf("Reliable   {rate}% over 7 days, p50 {p50} ms, p95 {p95} ms", {
				p50: "180",
				p95: "420",
				rate: "99.5",
			})
		).toBe("Zuverlässigkeit 99.5 % über 7 Tage, p50 180 ms, p95 420 ms");
		expect(german.tr(" Press  r to\tretry ")).toBe(
			" Drücke r, um es erneut zu versuchen "
		);
	});

	test("matches a thrown message against its catalog template", () => {
		expect(japanese.trMessage(DURATION_ERROR)).toBe(
			"期間「5x」が無効です。秒数またはサフィックスを使用してください: 90m、12h、30d、2w。"
		);
		expect(japanese.trMessage("Channels are offline.")).toBe(
			"チャネルはオフラインです。"
		);
		expect(japanese.trMessage("upstream said no")).toBe("upstream said no");
		expect(japanese.tr(DURATION_ERROR)).toBe(DURATION_ERROR);
	});

	test("formats a template-matched UsageError in Japanese, English under --json", () => {
		const error = new UsageError(DURATION_ERROR);
		expect(formatError(error, japanese)).toBe(
			"期間「5x」が無効です。秒数またはサフィックスを使用してください: 90m、12h、30d、2w。"
		);
		expect(errorToJson(error)).toEqual({ error: DURATION_ERROR });
		expect(formatError(error)).toBe(DURATION_ERROR);
	});

	test("translates a thrown message in Arabic and leaves English untouched", () => {
		const arabic = createCliTranslator("ar", {
			[DURATION]: "المدة '{value}' غير صالحة. استخدم الثواني أو لاحقة.",
		});
		// The captured value is isolated so the Latin token keeps its order.
		expect(arabic.trMessage(DURATION_ERROR)).toBe(
			"المدة '\u20685x\u2069' غير صالحة. استخدم الثواني أو لاحقة."
		);
		const english = createCliTranslator(null, null);
		expect(english.trMessage(DURATION_ERROR)).toBe(DURATION_ERROR);
	});
});
