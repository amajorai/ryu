import { describe, expect, test } from "bun:test";
import { formatMessage } from "./format.ts";
import { sentenceLabel } from "./sentence-label.ts";

const japanese: Record<string, string> = {
	"Free credit": "無料クレジット",
	Notifications: "通知",
};
const toJapanese = (source: string) => japanese[source] ?? source;
const toEnglish = (source: string) => source;

describe("sentenceLabel", () => {
	test("keeps English sentence casing", () => {
		expect(sentenceLabel(toEnglish, "Free credit")).toBe("free credit");
	});

	test("uses the translated label instead of lowercased English", () => {
		expect(sentenceLabel(toJapanese, "Free credit")).toBe("無料クレジット");
		expect(sentenceLabel(toJapanese, "Notifications")).toBe("通知");
	});

	test("does not lowercase a translation", () => {
		const toGerman = (source: string) =>
			source === "Plan credits" ? "Plan-Guthaben" : source;
		expect(sentenceLabel(toGerman, "Plan credits")).toBe("Plan-Guthaben");
	});

	test("falls back to lowercased English when the catalog has no entry", () => {
		expect(sentenceLabel(toJapanese, "Gift balance")).toBe("gift balance");
	});
});

// End to end against the shipped catalogs: the sentence and the label both
// come from the real locale files, as `tl()` resolves them at runtime.
describe("sentenceLabel with the shipped catalogs", () => {
	const shipped = async (locale: string) => {
		const catalog = (await Bun.file(
			new URL(`../locales/${locale}.json`, import.meta.url)
		).json()) as Record<string, string>;
		const tl = (source: string, values: Record<string, string> = {}) =>
			formatMessage(catalog[source] ?? source, values, locale);
		return (label: string) =>
			tl("About {label}", { label: sentenceLabel(tl, label) });
	};

	test("ja, ar and de splice the translated label, never English", async () => {
		const about = {
			ar: await shipped("ar"),
			de: await shipped("de"),
			ja: await shipped("ja"),
		};
		expect(about.ja("Plan credits")).toBe("プランクレジットについて");
		expect(about.ar("Gift balance")).toBe("حول رصيد الهدايا");
		// German keeps the noun's capital letter.
		expect(about.de("Plan credits")).toBe("Über Plan-Credits");
		for (const render of Object.values(about)) {
			expect(render("Gift balance")).not.toMatch(/gift balance/iu);
		}
	});

	test("English output is unchanged", () => {
		const tl = (source: string, values: Record<string, string> = {}) =>
			formatMessage(source, values, "en");
		expect(
			tl("About {label}", { label: sentenceLabel(tl, "Plan credits") })
		).toBe("About plan credits");
	});
});
