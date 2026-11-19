// The permission prompt's hint line translates each segment before the join.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../../i18n/translate.ts";

const german = createCliTranslator("de", {
	"1 select": "1 wählen",
	"1-{count} select": "1-{count} wählen",
	"Enter confirm": "Enter bestätigen",
	"Esc reject": "Esc ablehnen",
	"PgUp/PgDn scroll": "PgUp/PgDn blättern",
	"{arrows} move": "{arrows} bewegen",
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
const { permissionHintLine } = await import("./permission-hints.ts");

describe("permission hint line under German", () => {
	test("every segment is translated before the join", () => {
		expect(
			permissionHintLine({ count: 3, scrollable: true, unicode: true })
		).toBe(
			"1-3 wählen · ←/→ bewegen · Enter bestätigen · Esc ablehnen · PgUp/PgDn blättern"
		);
	});

	test("one option and ASCII arrows", () => {
		expect(
			permissionHintLine({ count: 1, scrollable: false, unicode: false })
		).toBe("1 wählen - left/right bewegen - Enter bestätigen - Esc ablehnen");
	});
});
