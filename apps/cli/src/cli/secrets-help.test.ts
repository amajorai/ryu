import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { renderSecretsHelp } from "./secrets-help.ts";

const german = createCliTranslator("de", {
	"Values:": "Werte:",
	"List visible values (metadata only)":
		"Sichtbare Werte auflisten (nur Metadaten)",
	"Exit 1 when invalid": "Beendet mit 1, wenn ungültig",
	"Revoke RYU_VAULT_TOKEN": "RYU_VAULT_TOKEN widerrufen",
	"Sub-folders and local env files (run without --broker):":
		"Unterordner und lokale env-Dateien (run ohne --broker):",
});

describe("secrets help", () => {
	test("headings and descriptions render in the locale; usages stay verbatim", () => {
		const help = renderSecretsHelp(german);
		expect(help).toContain("Werte:");
		expect(help).toMatch(
			/ {2}list \[--env E\] \[--path P\] +Sichtbare Werte auflisten \(nur Metadaten\)/u
		);
		expect(help).toMatch(
			/transit verify KEY.*\n +Beendet mit 1, wenn ungültig/u
		);
		expect(help).toMatch(/ {2}logout +RYU_VAULT_TOKEN widerrufen/u);
		expect(help).toContain("Unterordner und lokale env-Dateien");
		expect(help).toContain("ryu-cli secrets — ");
	});

	test("English stays the default and keeps every usage", () => {
		const help = renderSecretsHelp(createCliTranslator(null, null));
		expect(help).toContain("scan --history [REV-RANGE] [--max-commits N]");
		expect(help).toContain("RYU_SECRETS_SCAN_ALLOW_OFFLINE=1");
		expect(help).toContain("access request PATH");
	});
});
