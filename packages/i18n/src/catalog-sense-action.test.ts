import { describe, expect, test } from "bun:test";

// "Action" is an operation: a workflow step, a menu or toolbar command, an
// audit verb. The moderation decision a person is told about (the appeal
// summary, the platform floor rule column) has its own "Action taken" key, so
// the bare word no longer reads as a sanction (措置, Maßnahme, Мера).

interface ActionSenses {
	action: string;
	actionTaken: string;
}

const EXPECTED: Readonly<Record<string, ActionSenses>> = {
	de: { action: "Aktion", actionTaken: "Maßnahme" },
	es: { action: "Acción", actionTaken: "Medida" },
	fr: { action: "Action", actionTaken: "Mesure" },
	it: { action: "Azione", actionTaken: "Provvedimento" },
	ja: { action: "アクション", actionTaken: "措置" },
	ko: { action: "작업", actionTaken: "조치" },
	"pt-BR": { action: "Ação", actionTaken: "Medida" },
	ru: { action: "Действие", actionTaken: "Мера" },
	"zh-CN": { action: "操作", actionTaken: "处理措施" },
};

const readCatalog = async (path: string) =>
	(await Bun.file(
		new URL(`../locales/${path}.json`, import.meta.url)
	).json()) as Record<string, string>;

describe('"Action" reads as an operation', () => {
	test.each(
		Object.entries(EXPECTED)
	)("the root %s catalog separates the operation from the moderation measure", async (locale, expected) => {
		const catalog = await readCatalog(locale);
		expect({
			action: catalog.Action,
			actionTaken: catalog["Action taken"],
		}).toEqual(expected);
	});
});
