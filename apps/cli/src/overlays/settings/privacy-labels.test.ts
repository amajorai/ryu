// A failed privacy save names its setting in the reader's language, and the
// support-access state is translated.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../../i18n/translate.ts";

const german = createCliTranslator("de", {
	"Couldn't save {label}: {error}. Press r to retry.":
		"{label} konnte nicht gespeichert werden: {error}. Drücken Sie r, um es erneut zu versuchen.",
	"ending support access": "das Beenden des Supportzugriffs",
	Expired: "Abgelaufen",
	OFF: "AUS",
	"ON · no expiry": "AN · ohne Ablauf",
	"the analytics choice": "die Analyse-Auswahl",
	"the diagnostics endpoint": "den Diagnose-Endpunkt",
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
const { privacySaveLabel, supportStateLabel } = await import(
	"./privacy-labels.ts"
);

describe("privacy labels under German", () => {
	test("the save error names the setting in German", () => {
		expect(
			german.tf("Couldn't save {label}: {error}. Press r to retry.", {
				error: "timeout",
				label: privacySaveLabel("analytics", false),
			})
		).toBe(
			"die Analyse-Auswahl konnte nicht gespeichert werden: timeout. Drücken Sie r, um es erneut zu versuchen."
		);
		expect(privacySaveLabel("diagnosticsEndpoint", false)).toBe(
			"den Diagnose-Endpunkt"
		);
		expect(privacySaveLabel("supportAccess", true)).toBe(
			"das Beenden des Supportzugriffs"
		);
	});

	test("the support-access state reads in German", () => {
		expect(
			supportStateLabel({ supportAccess: false, supportExpiry: 0 }, 10)
		).toBe("AUS");
		expect(
			supportStateLabel({ supportAccess: true, supportExpiry: 0 }, 10)
		).toBe("AN · ohne Ablauf");
		expect(
			supportStateLabel({ supportAccess: true, supportExpiry: 5 }, 10)
		).toBe("Abgelaufen");
	});
});
