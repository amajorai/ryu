import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { renderConnectHelp } from "./connect-help.ts";

describe("connect help", () => {
	test("descriptions render in the locale while usages stay verbatim", () => {
		const german = createCliTranslator("de", {
			"Usage:": "Verwendung:",
			"What new calls can spend right now":
				"Was neue Aufrufe jetzt ausgeben können",
			"Add --json for machine-readable output.":
				"Fügen Sie --json für maschinenlesbare Ausgabe hinzu.",
		});
		const help = renderConnectHelp(german);
		expect(help).toContain("Verwendung:");
		expect(help).toMatch(
			/ryu-cli connect balance\s+Was neue Aufrufe jetzt ausgeben können/u
		);
		expect(help).toContain(
			"Fügen Sie --json für maschinenlesbare Ausgabe hinzu."
		);
		expect(help).toContain("RYU_CONNECT_KEY");
	});
});
