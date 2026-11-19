// The Apps tab's status column and "already installed" notice are whole
// catalog entries per install state, so no raw `installing` id lands inside
// translated text. The stub catalog stands in for the German pack.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"{name} is already being installed": "{name} wird bereits installiert",
	"{name} is already installed": "{name} ist bereits installiert",
	failed: "fehlgeschlagen",
	installed: "installiert",
	installing: "wird installiert",
	working: "in Arbeit",
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
const { alreadyInstalledText, appStatusFor, appStatusText } = await import(
	"./apps-status.ts"
);

const COLORS = {
	error: "red",
	info: "blue",
	mutedForeground: "gray",
	success: "green",
};

describe("Apps tab status copy under German", () => {
	test("each install state shows its German label with its icon and color", () => {
		expect(appStatusFor("installed", COLORS)).toEqual({
			color: "green",
			icon: "●",
			label: "installiert",
		});
		expect(appStatusText(appStatusFor("installing", COLORS), false)).toBe(
			"◌ wird installiert"
		);
		expect(appStatusText(appStatusFor("failed", COLORS), false)).toBe(
			"✗ fehlgeschlagen"
		);
	});

	test("a busy row says it is working, in German", () => {
		expect(appStatusText(appStatusFor("installed", COLORS), true)).toBe(
			"◌ in Arbeit"
		);
	});

	test("an unknown state shows a dash, not a raw id", () => {
		expect(appStatusText(appStatusFor("queued", COLORS), false)).toBe("  -");
	});

	test("the already-installed notice is a whole German sentence per state", () => {
		expect(alreadyInstalledText("Notes", "installed")).toBe(
			"Notes ist bereits installiert"
		);
		expect(alreadyInstalledText("Notes", "installing")).toBe(
			"Notes wird bereits installiert"
		);
	});
});
