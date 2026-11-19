// "name" is on the extractor's ignore list, so the detail panes' name row goes
// through the catalogued "Name" outside English.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const japanese = createCliTranslator("ja", { Name: "名前" });
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
const { nameFieldLabel } = await import("./name-field-label.ts");

describe("name field label", () => {
	test("uses the catalogued Name outside English", () => {
		expect(nameFieldLabel()).toBe("名前");
	});
});
