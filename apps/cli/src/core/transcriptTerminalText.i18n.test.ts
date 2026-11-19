// The truncation marker names what was cut ("[Nachricht gekürzt: …]"). The
// kind label is a literal the extractor collects, translated into the marker.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"[{label} truncated: {count, plural, one {# more line} other {# more lines}}]":
		"[{label} gekürzt: {count, plural, one {# weitere Zeile} other {# weitere Zeilen}}]",
	message: "Nachricht",
	thinking: "Denken",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { boundTerminalText } = await import("./transcriptTerminalText.ts");

describe("truncation marker under German", () => {
	test("names the truncated kind in German", () => {
		const bounded = boundTerminalText("a\nb\nc\nd", {
			label: "message",
			maxChars: 200,
			maxLines: 2,
		});
		expect(bounded.text).toBe("a\n[Nachricht gekürzt: 2 weitere Zeilen]");
		const thinking = boundTerminalText("a\nb\nc", {
			label: "thinking",
			maxChars: 200,
			maxLines: 2,
		});
		expect(thinking.text).toContain("[Denken gekürzt:");
	});
});
