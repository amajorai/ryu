import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { createChatRefusalText } from "./chatRefusalText.ts";

const german = createCliTranslator("de", {
	"HTTP {status} · {reason}": "HTTP {status} · {reason}",
	"Model {model} is not available.": "Modell {model} ist nicht verfügbar.",
	"Ryu credits exhausted": "Ryu-Credits aufgebraucht",
});
const chatRefusalText = createChatRefusalText(german);

describe("chatRefusalText", () => {
	test("translates a catalogued literal reason after the status", () => {
		expect(chatRefusalText("HTTP 402 · Ryu credits exhausted")).toBe(
			"HTTP 402 · Ryu-Credits aufgebraucht"
		);
	});

	test("fills a catalogued template reason with its captured values", () => {
		expect(chatRefusalText("HTTP 404 · Model gpt-x is not available.")).toBe(
			"HTTP 404 · Modell gpt-x ist nicht verfügbar."
		);
	});

	test("keeps a bare status, unknown reasons and other text as sent", () => {
		expect(chatRefusalText("HTTP 500")).toBe("HTTP 500");
		expect(chatRefusalText("HTTP 503 · upstream overloaded")).toBe(
			"HTTP 503 · upstream overloaded"
		);
		expect(chatRefusalText("socket hang up")).toBe("socket hang up");
	});
});
