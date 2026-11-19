import { describe, expect, test } from "bun:test";

// Round 43 catalog values whose every caller shares one meaning:
// - "Start recording" / "Stop recording" are audio (voice samples, meetings,
//   dictation; ja 録音). The Clips and Workflows recorders use sense ids.
// - "Occasion" is a family event (ja 行事), not an opportunity (ja 機会).
// - "Where it lives" is where software runs, not where a creature lives.
// - "Issued by" and "Remixed from" are bare labels beside their value, so no
//   locale adds a trailing colon.
// - The Arabic CLI "Wrote {count} names" carries every Arabic plural arm.

const LOCALES = [
	"ar",
	"de",
	"es",
	"fr",
	"hi",
	"it",
	"ja",
	"ko",
	"pt-BR",
	"ru",
	"zh-CN",
] as const;

const LOCALES_DIR = new URL("../locales/", import.meta.url);

const readCatalog = async (locale: string) =>
	(await Bun.file(new URL(`${locale}.json`, LOCALES_DIR)).json()) as Record<
		string,
		string
	>;

describe("round 43 catalog senses", () => {
	test("recording controls read as audio in ja, ko and zh-CN", async () => {
		const expected: Record<string, [string, string]> = {
			ja: ["録音を開始", "録音を停止"],
			ko: ["녹음 시작", "녹음 중지"],
			"zh-CN": ["开始录音", "停止录音"],
		};
		for (const [locale, [start, stop]] of Object.entries(expected)) {
			const catalog = await readCatalog(locale);
			expect(catalog["Start recording"]).toBe(start);
			expect(catalog["Stop recording"]).toBe(stop);
		}
	});

	test("a family occasion is an event in Japanese", async () => {
		expect((await readCatalog("ja")).Occasion).toBe("行事");
	});

	test("where it lives means where it runs", async () => {
		const living = /\b(lebt|vit|vive)\b|живёт|يعيش|रहता/u;
		for (const locale of LOCALES) {
			const value = (await readCatalog(locale))["Where it lives"] ?? "";
			expect({ locale, value, living: living.test(value) }).toEqual({
				locale,
				value,
				living: false,
			});
		}
	});

	test("label-only keys carry no trailing colon", async () => {
		for (const locale of LOCALES) {
			const catalog = await readCatalog(locale);
			for (const key of ["Issued by", "Remixed from"]) {
				const value = catalog[key] ?? "";
				expect({ key, locale, colon: /[:：]\s*$/u.test(value) }).toEqual({
					key,
					locale,
					colon: false,
				});
			}
		}
	});

	test("the Arabic names count has every plural arm", async () => {
		const value =
			(await readCatalog("ar"))[
				"Wrote {count, plural, one {# name} other {# names}} to {file}."
			] ?? "";
		for (const arm of ["zero", "one", "two", "few", "many", "other"]) {
			expect(value).toContain(`${arm} {`);
		}
	});
});
