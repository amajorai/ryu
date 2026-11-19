// Spaces counts use each locale's plural forms.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../../i18n/translate.ts";

const german = createCliTranslator("de", {
	"{count, plural, one {# doc} other {# docs}}":
		"{count, plural, one {# Dokument} other {# Dokumente}}",
	"{count, plural, one {# message} other {# messages}}":
		"{count, plural, one {# Nachricht} other {# Nachrichten}}",
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
const { documentCountLabel, messageCountLabel } = await import(
	"./space-counts.ts"
);

describe("space counts under German", () => {
	test("document and message counts pick the plural form", () => {
		expect(documentCountLabel(1)).toBe("1 Dokument");
		expect(documentCountLabel(4)).toBe("4 Dokumente");
		expect(messageCountLabel(1)).toBe("1 Nachricht");
		expect(messageCountLabel(7)).toBe("7 Nachrichten");
	});
});
