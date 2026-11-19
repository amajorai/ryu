// The setup step chips and the "recommended" badge are translated before the
// brackets and number are added.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../../i18n/translate.ts";

const german = createCliTranslator("de", {
	Providers: "Anbieter",
	recommended: "empfohlen",
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
const { catalogBadge, stepLabel } = await import("./setup-labels.ts");

describe("setup labels under German", () => {
	test("the current step is bracketed around the translated title", () => {
		expect(stepLabel(1, "Providers", true)).toBe("[2 Anbieter]");
		expect(stepLabel(1, "Providers", false)).toBe("2 Anbieter");
	});

	test("a recommended row's badge is translated; an install state wins", () => {
		expect(catalogBadge(undefined, true)).toBe("empfohlen");
		expect(catalogBadge("installed", true)).toBe("installed");
		expect(catalogBadge("not_installed", false)).toBeUndefined();
	});
});
