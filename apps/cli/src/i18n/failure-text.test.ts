import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFailureText } from "./failure-text.ts";
import { createCliTranslator } from "./translate.ts";

// A stub catalog standing in for a translated locale.
const translator = createCliTranslator("de", {
	"fork failed: {0}": "Abzweigen fehlgeschlagen: {0}",
	"Fork conversation failed: {status}":
		"Unterhaltung konnte nicht abgezweigt werden: {status}",
	"workflow run failed: {0}": "Workflow-Lauf fehlgeschlagen: {0}",
	"Core isn't reachable": "Core ist nicht erreichbar",
	"Core isn't reachable at {hostPort}":
		"Core ist unter {hostPort} nicht erreichbar",
});
const failureText = createFailureText(translator);

describe("failureText", () => {
	test("a catalogued thrown template renders translated inside the toast", () => {
		const toast = translator.tf("fork failed: {0}", {
			0: failureText(new Error("Fork conversation failed: 409")),
		});
		expect(toast).toBe(
			"Abzweigen fehlgeschlagen: Unterhaltung konnte nicht abgezweigt werden: 409"
		);
	});

	test("a connection failure reads as the localized unreachable sentence", () => {
		const refused = Object.assign(new Error("Unable to connect"), {
			code: "ConnectionRefused",
		});
		expect(
			translator.tf("workflow run failed: {0}", { 0: failureText(refused) })
		).toBe("Workflow-Lauf fehlgeschlagen: Core ist nicht erreichbar");
	});

	test("uncatalogued server text passes through unchanged", () => {
		expect(failureText(new Error("quota_exceeded (req 7f3a)"))).toBe(
			"quota_exceeded (req 7f3a)"
		);
		expect(failureText("plain")).toBe("plain");
	});
});

describe("chat and workflow failure toasts", () => {
	const surfaces = join(import.meta.dir, "..", "surfaces");
	test.each([
		"chat/index-runners.ts",
		"chat/index-compose-keys.ts",
		"chat/index-overlay-keys.ts",
		"workflows/index.tsx",
	])("%s translates the caught reason", (file) => {
		const source = readFileSync(join(surfaces, file), "utf8");
		expect(source).not.toContain("nativeErrorMessage as errText");
		expect(source).toContain(
			'import { failureText as errText } from "../../i18n/failure-text.ts";'
		);
	});
});
