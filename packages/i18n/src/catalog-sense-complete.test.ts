import { describe, expect, test } from "bun:test";

// "Complete" is a finished state: a run, a step, an onboarding checklist that
// is done (完了, Abgeschlossen, مكتمل). The full file-tree icon set and the
// agent audit's coverage carry their own strings ("Full set", "Full audit",
// "Partial audit"), so the bare word no longer has to mean "full" (完全, Полный).

interface CompleteSenses {
	complete: string;
	fullAudit: string;
	fullSet: string;
	partialAudit: string;
}

const EXPECTED: Readonly<Record<string, CompleteSenses>> = {
	ar: {
		complete: "مكتمل",
		fullAudit: "تدقيق كامل",
		fullSet: "المجموعة الكاملة",
		partialAudit: "تدقيق جزئي",
	},
	de: {
		complete: "Abgeschlossen",
		fullAudit: "Vollständiges Audit",
		fullSet: "Vollständiger Satz",
		partialAudit: "Teilaudit",
	},
	es: {
		complete: "Completado",
		fullAudit: "Auditoría completa",
		fullSet: "Conjunto completo",
		partialAudit: "Auditoría parcial",
	},
	fr: {
		complete: "Terminé",
		fullAudit: "Audit complet",
		fullSet: "Ensemble complet",
		partialAudit: "Audit partiel",
	},
	hi: {
		complete: "पूर्ण",
		fullAudit: "पूर्ण ऑडिट",
		fullSet: "पूरा सेट",
		partialAudit: "आंशिक ऑडिट",
	},
	it: {
		complete: "Completato",
		fullAudit: "Audit completo",
		fullSet: "Set completo",
		partialAudit: "Audit parziale",
	},
	ja: {
		complete: "完了",
		fullAudit: "完全な監査",
		fullSet: "フルセット",
		partialAudit: "部分的な監査",
	},
	ko: {
		complete: "완료",
		fullAudit: "전체 감사",
		fullSet: "전체 세트",
		partialAudit: "부분 감사",
	},
	"pt-BR": {
		complete: "Concluído",
		fullAudit: "Auditoria completa",
		fullSet: "Conjunto completo",
		partialAudit: "Auditoria parcial",
	},
	ru: {
		complete: "Завершено",
		fullAudit: "Полный аудит",
		fullSet: "Полный набор",
		partialAudit: "Частичный аудит",
	},
	"zh-CN": {
		complete: "已完成",
		fullAudit: "完整审计",
		fullSet: "完整图标集",
		partialAudit: "部分审计",
	},
};

const readCatalog = async (path: string) =>
	(await Bun.file(
		new URL(`../locales/${path}.json`, import.meta.url)
	).json()) as Record<string, string>;

describe('"Complete" reads as finished', () => {
	test.each(
		Object.entries(EXPECTED)
	)("the root %s catalog separates the finished state from full coverage", async (locale, expected) => {
		const catalog = await readCatalog(locale);
		expect({
			complete: catalog.Complete,
			fullAudit: catalog["Full audit"],
			fullSet: catalog["Full set"],
			partialAudit: catalog["Partial audit"],
		}).toEqual(expected);
	});

	test("the RLM run view's Japanese pack shows a finished run as 完了", async () => {
		const catalog = await readCatalog("apps/rlm/ja");
		expect(catalog.Complete).toBe("完了");
	});
});
