// A ListTab row action reports back as one whole sentence per action, so the
// notice is translated with only the row id filled in. The stub catalog stands
// in for the German pack.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"Active model: {name}": "Aktives Modell: {name}",
	"Activated {name}": "{name} aktiviert",
	"Checked {name}": "{name} geprüft",
	"Error: {message}": "Fehler: {message}",
	"Installing {name}… (press r to refresh)":
		"{name} wird installiert… (r zum Aktualisieren drücken)",
	"Queued install: {name}": "Installation eingereiht: {name}",
	"Replayed {name}": "{name} erneut abgespielt",
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
const {
	activatedNotice,
	activeModelNotice,
	checkedNotice,
	installingNotice,
	listActionErrorNotice,
	queuedInstallNotice,
	replayedNotice,
} = await import("./list-notices.ts");

describe("ListTab row-action notices under German", () => {
	test("each action's notice is its own German sentence around the id", () => {
		expect(queuedInstallNotice("llama-3")).toBe(
			"Installation eingereiht: llama-3"
		);
		expect(activeModelNotice("llama-3")).toBe("Aktives Modell: llama-3");
		expect(activatedNotice("docs")).toBe("docs aktiviert");
		expect(replayedNotice("rec_1")).toBe("rec_1 erneut abgespielt");
		expect(checkedNotice("mon_1")).toBe("mon_1 geprüft");
		expect(installingNotice("whisper")).toBe(
			"whisper wird installiert… (r zum Aktualisieren drücken)"
		);
	});

	test("a failed action is framed in German and keeps its reason", () => {
		expect(listActionErrorNotice("Core is offline")).toBe(
			"Fehler: Core is offline"
		);
	});

	test("no notice leaves the old English fragments behind", () => {
		for (const text of [
			queuedInstallNotice("x"),
			activatedNotice("x"),
			replayedNotice("x"),
			checkedNotice("x"),
		]) {
			expect(text).not.toMatch(/queued|activated|replayed|checked/u);
		}
	});
});
