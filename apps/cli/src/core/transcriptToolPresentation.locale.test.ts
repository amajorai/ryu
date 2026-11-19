import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

// The search summary composed `"pattern" in path` in English; pin a German
// stub catalog before the module loads, the way LANG=de_DE.UTF-8 does.
const german = createCliTranslator("de", {
	'"{pattern}" in {path}': '"{pattern}" in {path} (de)',
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
const { toolSummary, toolPendingLabel } = await import(
	"./transcriptToolPresentation.ts"
);

describe("tool presentation copy", () => {
	test("the search summary is one translated sentence", () => {
		expect(toolSummary("Grep", { pattern: "foo", path: "src" })).toBe(
			'"foo" in src (de)'
		);
		expect(toolSummary("Glob", { pattern: "**/*.ts" })).toBe('"**/*.ts"');
	});

	test("write and edit rows use whole-phrase labels, not the authoring sense", () => {
		expect(toolPendingLabel("Write")).toBe("Writing file");
		expect(toolPendingLabel("Edit")).toBe("Editing file");
	});
});
