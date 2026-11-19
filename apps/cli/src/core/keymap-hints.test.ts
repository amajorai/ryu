// Hint lines are joined with " · ", so the joined line never matches a catalog
// key: each "{keys} {label}" segment is translated whole before the join.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"Enter open": "Enter öffnen",
	"Esc back": "Esc zurück",
	"r refresh": "r aktualisieren",
	"↑↓ move": "↑↓ bewegen",
	"Enter detail": "Enter Details",
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
const { HINT, hintText } = await import("./keymap.ts");
const { hintSegment } = await import("./keymap-hints.ts");

describe("hint lines under German", () => {
	test("each segment is translated before the segments are joined", () => {
		expect(hintText([HINT.move, HINT.open, HINT.refresh, HINT.back])).toBe(
			"↑↓ bewegen · Enter öffnen · r aktualisieren · Esc zurück"
		);
	});

	test("a surface's own segment is looked up whole", () => {
		expect(hintSegment({ keys: "Enter", label: "detail" })).toBe(
			"Enter Details"
		);
	});

	test("an uncatalogued segment stays English", () => {
		expect(hintText([{ keys: "q", label: "quit" }, HINT.back])).toBe(
			"q quit · Esc zurück"
		);
	});
});
