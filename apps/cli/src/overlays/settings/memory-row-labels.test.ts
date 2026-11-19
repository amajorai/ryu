// A failed Memory save names its row in the reader's language.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../../i18n/translate.ts";

const german = createCliTranslator("de", {
	"the context budget": "das Kontextbudget",
	"the recall limit": "das Abruflimit",
	"the reply reserve": "die Antwortreserve",
});
mock.module("../../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { memorySaveLabel } = await import("./memory-row-labels.ts");

describe("memory save labels under German", () => {
	test("each edited row is named in German", () => {
		expect(memorySaveLabel("contextBudget")).toBe("das Kontextbudget");
		expect(memorySaveLabel("topK")).toBe("das Abruflimit");
		expect(memorySaveLabel("contextReserve")).toBe("die Antwortreserve");
	});
});
