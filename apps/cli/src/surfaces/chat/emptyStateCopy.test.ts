// The hero's mode line and hint chips are whole catalogued phrases, translated
// before the hero measures its column.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../../i18n/translate.ts";

const german = createCliTranslator("de", {
	"/ commands": "/ Befehle",
	"@ mention": "@ erwähnen",
	"Agent: {agent}": "Agent: {agent}",
	"Ask anything": "Etwas fragen",
	"Chat with Ryu": "Mit Ryu chatten",
	"Ctrl+A pick agent": "Ctrl+A Agent wählen",
	"Ctrl+Q queue": "Ctrl+Q Warteschlange",
	"Group: {team}": "Gruppe: {team}",
	Resume: "Fortsetzen",
});
mock.module("../../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { emptyStateHints, emptyStateMode, recentResumeLabel } = await import(
	"./emptyStateCopy.ts"
);

describe("empty-state hero copy under German", () => {
	test("the mode line names the group or agent in German", () => {
		expect(emptyStateMode("ops", null)).toBe("Gruppe: ops");
		expect(emptyStateMode(null, null)).toBe("Etwas fragen");
	});

	test("each hint chip is translated whole", () => {
		expect(emptyStateHints(true)).toEqual(["Mit Ryu chatten", "/ Befehle"]);
		expect(emptyStateHints(false)).toEqual([
			"Ctrl+A Agent wählen",
			"/ Befehle",
			"@ erwähnen",
			"Ctrl+Q Warteschlange",
		]);
	});

	test("the recent-row label is translated", () => {
		expect(recentResumeLabel()).toBe("Fortsetzen");
	});
});
