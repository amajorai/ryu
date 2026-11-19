import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { createActionFailedText } from "./contributed-view-text.ts";

const german = createCliTranslator("de", {
	"Action {id} failed: {error}": "Aktion {id} fehlgeschlagen: {error}",
	"Core isn't reachable": "Core ist nicht erreichbar",
	"Identity verification was not confirmed.":
		"Die Identitätsprüfung wurde nicht bestätigt.",
});
const actionFailedText = createActionFailedText(german);

describe("actionFailedText", () => {
	test("wraps a catalogued reason in the translated action sentence", () => {
		expect(
			actionFailedText(
				"archive",
				new Error("Identity verification was not confirmed.")
			)
		).toBe(
			"Aktion archive fehlgeschlagen: Die Identitätsprüfung wurde nicht bestätigt."
		);
	});

	test("a refused connection reads as the unreachable sentence", () => {
		const refused = Object.assign(new Error("Unable to connect"), {
			code: "ConnectionRefused",
		});
		expect(actionFailedText("save", refused)).toBe(
			"Aktion save fehlgeschlagen: Core ist nicht erreichbar"
		);
	});

	test("server text passes through", () => {
		expect(actionFailedText("save", "boom (req 1)")).toBe(
			"Aktion save fehlgeschlagen: boom (req 1)"
		);
	});
});
