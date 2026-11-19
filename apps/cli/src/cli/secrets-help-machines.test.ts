import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { renderHelpEntries } from "./secrets-help-format.ts";
import { machineHelpEntries } from "./secrets-help-machines.ts";

describe("secrets machine help", () => {
	test("prose and descriptions translate; token usages stay verbatim", () => {
		const german = createCliTranslator("de", {
			"Machine tokens:": "Maschinentoken:",
			"Print a vault token": "Ein Tresor-Token ausgeben",
		});
		const text = renderHelpEntries(machineHelpEntries(german)).join("\n");
		expect(text).toContain("Maschinentoken:");
		expect(text).toMatch(
			/login --approle ROLE_ID SECRET_ID \| login --jwt IDENTITY JWT\n +Ein Tresor-Token ausgeben/u
		);
		expect(text).toContain("  machine list | machine delete NAME");
	});
});
