// Palette entries show in the reader's language and rank on both the
// translated label and the original English one.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const japanese = createCliTranslator("ja", {
	"Close tab": "タブを閉じる",
	"Go to {label}": "{label} に移動",
	Inbox: "受信トレイ",
	"Reset layout": "レイアウトをリセット",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "ja",
	CLI_LOCALE: "ja",
	CLI_TRANSLATOR: japanese,
	createCliTranslator,
	tf: japanese.tf,
	tr: japanese.tr,
	trMessage: japanese.trMessage,
	translateProps: japanese.translateProps,
}));
const { localizePaletteAction } = await import("./localize.ts");
const { rankPaletteEntries } = await import("./rank.ts");

const run = () => undefined;
const entries = [
	localizePaletteAction({ id: "action:close-tab", label: "Close tab", run }),
	localizePaletteAction({
		aliases: ["restore"],
		id: "layout:reset",
		label: "Reset layout",
		run,
	}),
	localizePaletteAction(
		{
			id: "nav:/inbox",
			label: japanese.tf("Go to {label}", {
				label: japanese.tr("Inbox"),
			}),
			run,
		},
		"Go to Inbox"
	),
];
const ids = (query: string) =>
	rankPaletteEntries(entries, query).map((entry) => entry.id);

describe("command palette under Japanese", () => {
	test("labels are shown in Japanese", () => {
		expect(entries.map((entry) => entry.label)).toEqual([
			"タブを閉じる",
			"レイアウトをリセット",
			"受信トレイ に移動",
		]);
	});

	test("a Japanese query finds the Japanese label", () => {
		expect(ids("閉じる")).toEqual(["action:close-tab"]);
		expect(ids("受信")).toEqual(["nav:/inbox"]);
	});

	test("the English label and existing aliases still match", () => {
		expect(ids("close tab")).toEqual(["action:close-tab"]);
		expect(ids("go to inbox")).toEqual(["nav:/inbox"]);
		expect(ids("restore")).toEqual(["layout:reset"]);
	});

	test("an entry without a translation is left as it is", () => {
		const entry = { id: "action:quit", label: "Quit", run };
		expect(localizePaletteAction(entry)).toBe(entry);
	});
});
