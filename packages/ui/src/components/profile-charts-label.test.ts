import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { chartEntryTitle } from "./profile-charts-label.ts";

/** A Japanese catalog that knows the words the title is built from. */
const JA: Record<string, string> = {
	"{feature}: {count}": "{feature}: {count}",
	Autocomplete: "オートコンプリート",
	Chat: "チャット",
};

const ja = (source: string, values?: MessageValuesInput) =>
	formatMessage(JA[source] ?? source, values ?? {}, "ja");
const en = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values ?? {}, "en");
const plain = (value: number) => String(value);

describe("chartEntryTitle", () => {
	test("reads as before in English", () => {
		expect(chartEntryTitle(en, "Chat", 3, plain)).toBe("Chat: 3");
	});

	test("translates the series name", () => {
		expect(chartEntryTitle(ja, "Chat", 3, plain)).toBe("チャット: 3");
		expect(chartEntryTitle(ja, "Autocomplete", 4, plain)).toBe(
			"オートコンプリート: 4"
		);
	});

	test("formats the count with the shared formatter by default", () => {
		expect(chartEntryTitle(en, "Chat", 12)).toMatch(/^Chat: 12$/u);
	});
});
