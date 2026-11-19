import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { lifecycleRefusalText } from "./plugins-lifecycle-refusal.ts";

// A stub catalog standing in for a translated locale.
const german = createCliTranslator("de", {
	"{plugin} is needed by {names}. Disable {names} first.":
		"{plugin} wird von {names} benötigt. Deaktivieren Sie zuerst {names}.",
	"{plugin} needs {dependency} ({required} or newer). Install it first.":
		"{plugin} benötigt {dependency} ({required} oder neuer). Installieren Sie es zuerst.",
	"Circular dependency: {cycle}.": "Zirkuläre Abhängigkeit: {cycle}.",
	"Gateway denied grants: {denied}":
		"Gateway hat Berechtigungen verweigert: {denied}",
	"Gateway unreachable (fail-closed): {reason}":
		"Gateway nicht erreichbar (fail-closed): {reason}",
	"gateway unreachable": "Gateway nicht erreichbar",
	"You don't have permission ({permission}) to change apps on this node.":
		"Sie haben keine Berechtigung ({permission}), Apps auf diesem Knoten zu ändern.",
});

describe("lifecycleRefusalText", () => {
	test("rebuilds a blocked disable from the typed dependents", () => {
		expect(
			lifecycleRefusalText(
				{
					message:
						"whiteboard is needed by meetings, notes. Disable meetings, notes first.",
					dependencyError: {
						code: "blocked_by_dependents",
						plugin: "whiteboard",
						dependents: ["meetings", "notes"],
					},
				},
				german
			)
		).toBe(
			"whiteboard wird von meetings und notes benötigt. Deaktivieren Sie zuerst meetings und notes."
		);
	});

	test("rebuilds a missing dependency and a cycle", () => {
		expect(
			lifecycleRefusalText(
				{
					message: "English",
					dependencyError: {
						code: "missing_dependency",
						plugin: "meetings",
						dependency: "calendar",
						required: "1.2.0",
					},
				},
				german
			)
		).toBe(
			"meetings benötigt calendar (1.2.0 oder neuer). Installieren Sie es zuerst."
		);
		expect(
			lifecycleRefusalText(
				{
					message: "English",
					dependencyError: { code: "cycle", cycle: ["a", "b", "a"] },
				},
				german
			)
		).toBe("Zirkuläre Abhängigkeit: a → b → a.");
	});

	test("renders Gateway refusals from core-client's sentences", () => {
		expect(
			lifecycleRefusalText(
				{ message: "Gateway denied grants: net, fs", grantsDenied: true },
				german
			)
		).toBe("Gateway hat Berechtigungen verweigert: net, fs");
		expect(
			lifecycleRefusalText(
				{
					message: "Gateway unreachable (fail-closed): gateway unreachable",
					gatewayUnreachable: true,
				},
				german
			)
		).toBe("Gateway nicht erreichbar (fail-closed): Gateway nicht erreichbar");
	});

	test("renders the node permission refusal with its permission", () => {
		expect(
			lifecycleRefusalText(
				{
					message:
						"You don't have permission (apps.manage) to change apps on this node.",
				},
				german
			)
		).toBe(
			"Sie haben keine Berechtigung (apps.manage), Apps auf diesem Knoten zu ändern."
		);
	});

	test("Core's own reason passes through when it is not catalogued", () => {
		expect(lifecycleRefusalText({ message: "mandatory plugin" }, german)).toBe(
			"mandatory plugin"
		);
	});
});
