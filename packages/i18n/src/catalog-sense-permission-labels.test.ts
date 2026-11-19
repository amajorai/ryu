import { describe, expect, test } from "bun:test";

// Manifest permission levels are short labels that several apps share, and
// the sense-id mechanism does not reach manifest copy. Each label here is
// pinned to the sense its manifests declare:
// - "Can play" (token-table) is playing a game, never media playback ("Play");
// - "Can record" (meetings audio, recipes UI macros) stays neutral;
// - ru "Can train" is training models (обучать) and "Can teach" (learning)
//   creates skills, so the two do not collide.

const CAN_PLAY: Readonly<Record<string, string>> = {
	ar: "يمكنه اللعب",
	de: "Kann spielen",
	es: "Puede jugar",
	fr: "Peut jouer",
	hi: "खेल सकते हैं",
	ja: "プレイ可能",
	ko: "플레이 가능",
	"zh-CN": "可游玩",
};

const readCatalog = async (locale: string) =>
	(await Bun.file(
		new URL(`../locales/${locale}.json`, import.meta.url)
	).json()) as Record<string, string>;

describe("manifest permission labels keep their manifest sense", () => {
	test.each(
		Object.entries(CAN_PLAY)
	)('the %s catalog reads "Can play" as playing a game', async (locale, expected) => {
		const catalog = await readCatalog(locale);
		expect(catalog["Can play"]).toBe(expected);
		expect(catalog["Can play"]).not.toContain(catalog.Play ?? "\u0000");
	});

	test('"Can record" is neutral between audio and UI macros', async () => {
		expect((await readCatalog("ko"))["Can record"]).toBe("기록 가능");
		expect((await readCatalog("ja"))["Can record"]).toBe("記録可能");
	});

	test('ru keeps "Can train" and "Can teach" apart', async () => {
		const ru = await readCatalog("ru");
		expect(ru["Can train"]).toBe("Может обучать модели");
		expect(ru["Can teach"]).toBe("Может создавать навыки");
	});
});
