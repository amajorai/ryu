import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCliTranslator } from "../../i18n/translate.ts";
import { launchRefusalMessage } from "./index-edit-launch-refusal.ts";

// A stub catalog standing in for a translated locale.
const translator = createCliTranslator("de", {
	"Core says this agent's engine would not start.":
		"Laut Core würde die Engine dieses Agenten nicht starten.",
	"Nothing was saved.": "Es wurde nichts gespeichert.",
	"Engine {engine} needs a signed-in account.":
		"Die Engine {engine} benötigt ein angemeldetes Konto.",
	"Set the engine to {engineId} to run it on Ryu instead.":
		"Setzen Sie die Engine auf {engineId}, um ihn stattdessen auf Ryu auszuführen.",
	"Change how it works or its account access, or switch its engine with '{command}'.":
		"Ändern Sie die Arbeitsweise oder den Kontozugriff, oder wechseln Sie die Engine mit '{command}'.",
});

describe("launchRefusalMessage", () => {
	test("translates the default reason, the outcome and the new-agent hint", () => {
		expect(
			launchRefusalMessage(
				{
					agentId: "a1",
					engine: "codex",
					identityMode: "own",
					isNew: true,
					reason: null,
				},
				translator
			)
		).toBe(
			"Laut Core würde die Engine dieses Agenten nicht starten. Es wurde nichts gespeichert. Setzen Sie die Engine auf acp:pi, um ihn stattdessen auf Ryu auszuführen."
		);
	});

	test("translates Core's catalogued reason and names ryu-cli in the hint", () => {
		const message = launchRefusalMessage(
			{
				agentId: "a1",
				engine: "codex",
				identityMode: "own",
				isNew: false,
				reason: "Engine codex needs a signed-in account.",
			},
			translator
		);
		expect(message).toStartWith(
			"Die Engine codex benötigt ein angemeldetes Konto. Es wurde nichts gespeichert. Ändern Sie"
		);
		expect(message).toContain(
			"'ryu-cli agents identity a1 own --engine acp:pi'"
		);
	});

	test("keeps an uncatalogued Core reason verbatim and adds no hint for Ryu", () => {
		expect(
			launchRefusalMessage(
				{
					agentId: "a1",
					engine: "acp:pi",
					identityMode: "own",
					isNew: false,
					reason: "upstream refused (req 7f3a)",
				},
				translator
			)
		).toBe("upstream refused (req 7f3a) Es wurde nichts gespeichert.");
	});

	test("the editor's save throws the translated refusal", () => {
		const source = readFileSync(
			join(import.meta.dir, "index-edit-save.ts"),
			"utf8"
		);
		expect(source).toContain("launchRefusalMessage(");
		expect(source).not.toContain("Nothing was saved.");
	});
});
