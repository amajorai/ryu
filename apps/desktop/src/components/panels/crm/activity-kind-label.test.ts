import { afterEach, describe, expect, test } from "bun:test";
import {
	formatMessage,
	I18nRuntime,
	type MessageValuesInput,
} from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../../packages/i18n/src/active-locale.ts";
import {
	activityKindLabel,
	activityNoteLabel,
	activityTitle,
} from "./activity-kind-label.ts";

const MERGED =
	"{count, plural, one {Merged # record into this one} other {Merged # records into this one}}";

const RU: Record<string, string> = {
	Call: "Звонок",
	Meeting: "Встреча",
	Note: "Заметка",
	Task: "Задача",
	"Untitled call": "Звонок без названия",
	"Untitled meeting": "Встреча без названия",
	"Untitled note": "Заметка без названия",
	"Untitled task": "Задача без названия",
	[MERGED]:
		"{count, plural, one {В эту запись объединена # запись} few {В эту запись объединены # записи} many {В эту запись объединено # записей} other {В эту запись объединено # записи}}",
};
function tlRu(source: string, values?: MessageValuesInput): string {
	return formatMessage(RU[source] ?? source, values ?? {}, "ru");
}
function tlEn(source: string, values?: MessageValuesInput): string {
	return formatMessage(source, values ?? {}, "en");
}

let active: I18nRuntime | null = null;

function useLocale(packId: string): void {
	active = new I18nRuntime([], { initialPackId: packId });
	registerActiveI18nRuntime(active);
}

afterEach(() => {
	if (active) {
		unregisterActiveI18nRuntime(active);
		active = null;
	}
});

describe("activity kind label", () => {
	test("each authored kind reads as a translated word, not the enum", () => {
		useLocale("official/ru");
		expect(activityKindLabel("call", tlRu)).toBe("Звонок");
		expect(activityKindLabel("meeting", tlRu)).toBe("Встреча");
		expect(activityKindLabel("note", tlRu)).toBe("Заметка");
		expect(activityKindLabel("task", tlRu)).toBe("Задача");
	});

	test("the Chinese note kind is a CRM note, not an annotation", () => {
		// The bare catalog "Note" is an annotation (zh-CN "批注"); the badge
		// and the composer read the keyed `crm.activityNote`.
		useLocale("official/zh-cn");
		expect(activityKindLabel("note", tlEn)).toBe("备注");
		expect(activityNoteLabel()).toBe("备注");
	});

	test("English keeps Note", () => {
		expect(activityNoteLabel()).toBe("Note");
	});
});

describe("activity title", () => {
	test("the backend merge sentence is pluralized", () => {
		expect(activityTitle("Merged 1 record(s) into this one", tlEn)).toBe(
			"Merged 1 record into this one"
		);
		expect(activityTitle("Merged 3 record(s) into this one", tlEn)).toBe(
			"Merged 3 records into this one"
		);
		expect(activityTitle("Merged 3 record(s) into this one", tlRu)).toBe(
			"В эту запись объединены 3 записи"
		);
		expect(activityTitle("Merged 5 records into this one", tlRu)).toBe(
			"В эту запись объединено 5 записей"
		);
	});

	test("the backend's untitled placeholder reads as a whole sentence", () => {
		expect(activityTitle("Untitled call", tlRu)).toBe("Звонок без названия");
		expect(activityTitle("Untitled meeting", tlRu)).toBe(
			"Встреча без названия"
		);
		expect(activityTitle("Untitled note", tlRu)).toBe("Заметка без названия");
		expect(activityTitle("Untitled task", tlRu)).toBe("Задача без названия");
		expect(activityTitle("Untitled plan", tlRu)).toBe("Untitled plan");
	});

	test("the untitled placeholder is the backend's activity title", async () => {
		const insights = await Bun.file(
			`${import.meta.dir}/../../../../../../apps-store/crm/backend/src/api/insights.rs`
		).text();
		expect(insights).toContain(
			`format!("Untitled {}", kind.as_str().replace('_', " "))`
		);
	});

	test("an authored title is kept as is", () => {
		expect(activityTitle("Call Dana back", tlRu)).toBe("Call Dana back");
	});

	test("the recognized sentence is the backend's merge title", async () => {
		const merge = await Bun.file(
			`${import.meta.dir}/../../../../../../apps-store/crm/backend/src/store/merge.rs`
		).text();
		expect(merge).toContain('"Merged {} record(s) into this one"');
	});
});
