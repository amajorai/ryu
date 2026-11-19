import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { toolCallLabels } from "./tool-call-labels.ts";

describe("tool row labels", () => {
	test("every label renders in the locale", () => {
		const german = createCliTranslator("de", {
			"Args:": "Argumente:",
			"awaiting permission": "wartet auf Erlaubnis",
			denied: "abgelehnt",
			interrupted: "unterbrochen",
			"Result:": "Ergebnis:",
		});
		expect(toolCallLabels(german)).toEqual({
			args: "Argumente:",
			awaitingPermission: "wartet auf Erlaubnis",
			denied: "abgelehnt",
			interrupted: "unterbrochen",
			result: "Ergebnis:",
		});
	});
});
