import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { chefSheetSubtitle } from "./kitchen-panel-status.ts";

/** A Japanese catalog that knows the words the subtitle is built from. */
const JA: Record<string, string> = {
	"{station} · {status}": "{station}・{status}",
	Cooking: "調理中",
	Grill: "グリル",
	"Has a burnt order": "焦げた注文あり",
	Idle: "待機中",
	"Needs you": "対応が必要",
	Stove: "コンロ",
};

const ja = (source: string, values?: MessageValuesInput) =>
	formatMessage(JA[source] ?? source, values ?? {}, "ja");
const en = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values ?? {}, "en");

const idle = { burnt: false, kind: "grill", working: false } as const;

describe("chefSheetSubtitle", () => {
	test("reads as before in English", () => {
		expect(chefSheetSubtitle(en, idle, null)).toBe("Grill · Idle");
		expect(
			chefSheetSubtitle(en, { ...idle, kind: "stove", working: true }, null)
		).toBe("Stove · Cooking");
	});

	test("translates the station, the status and the joiner in ja", () => {
		expect(chefSheetSubtitle(ja, { ...idle, working: true }, null)).toBe(
			"グリル・調理中"
		);
		expect(chefSheetSubtitle(ja, { ...idle, burnt: true }, null)).toBe(
			"グリル・焦げた注文あり"
		);
	});

	test("an act's status word is translated too", () => {
		const asking = { act: "asking" } as InterfaceAgentAct;
		expect(chefSheetSubtitle(ja, idle, asking)).toBe("グリル・対応が必要");
	});
});
