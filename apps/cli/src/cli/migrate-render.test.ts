import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { nextSteps, padCell, statusLabel } from "./migrate-render.ts";

const english = createCliTranslator(null, null);
const german = createCliTranslator("de", {
	Skipped: "Übersprungen",
	"Next steps:": "Nächste Schritte:",
	"Keep the source folder until you have checked Ryu; migration copies, it never moves.":
		"Behalte den Quellordner, bis du Ryu geprüft hast; die Migration kopiert und verschiebt nie.",
});

describe("migrate report pieces", () => {
	test("status labels translate known outcomes and keep unknown ones", () => {
		expect(statusLabel("skipped", english)).toBe("Skipped");
		expect(statusLabel("skipped", german)).toBe("Übersprungen");
		expect(statusLabel("queued", german)).toBe("queued");
	});

	test("padCell pads by terminal columns, not code units", () => {
		expect(padCell("失敗", 6)).toBe("失敗  ");
		expect(padCell("Failed", 8)).toBe("Failed  ");
		expect(padCell("Overflowing", 4)).toBe("Overflowing");
	});

	test("next steps keep English by default and translate each sentence", () => {
		expect(nextSteps(english)).toBe(
			`Next steps:
  1. Start a new chat; imported agents, skills, and memory apply to new sessions.
  2. Review imported MCP servers in Settings → MCP; sign in again where they use OAuth or headers.
  3. Reconnect messaging channels and schedules listed under "Review before cutover".
  4. Keep the source folder until you have checked Ryu; migration copies, it never moves.
`
		);
		const steps = nextSteps(german);
		expect(steps.startsWith("Nächste Schritte:\n")).toBe(true);
		expect(steps).toContain(
			"  4. Behalte den Quellordner, bis du Ryu geprüft hast; die Migration kopiert und verschiebt nie.\n"
		);
	});
});
