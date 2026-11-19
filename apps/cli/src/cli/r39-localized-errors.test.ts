// Round 39: CLI failures that printed English after a translated "Error:"
// now carry their whole sentence as localized text, so human output renders
// it in the CLI locale while `--json` keeps the English message.
import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import type { AgentsArgs } from "./agents-args.ts";
import type { AgentIdentityView } from "./agents-core.ts";
import { pickCommand } from "./agents-picker.ts";
import { parseGatewayConfigPatch } from "./gatewayConfig.ts";
import { localizedTextOf, renderLocalized } from "./localizedText.ts";
import { SOURCES } from "./migrate-sources.ts";
import { errorToJson, formatError } from "./output.ts";
import { parseCardStdin } from "./secrets-items.ts";
import type { CliContext } from "./types.ts";

const german = createCliTranslator("de", {
	"Gateway TOML must include a writable section.":
		"Gateway-TOML muss einen beschreibbaren Abschnitt enthalten.",
	"stdin must hold the card number on the first line and, optionally, the CVC on the second.":
		"stdin muss in der ersten Zeile die Kartennummer und optional in der zweiten den CVC enthalten.",
	"'pick' asks on the terminal. For scripts, use 'ryu-cli agents access {id} available --json', then add or remove keys.":
		"'pick' fragt im Terminal. Verwenden Sie für Skripte 'ryu-cli agents access {id} available --json'.",
	"Export your data from ChatGPT (Settings → Data controls → Export data), unzip the download, and pass the folder that holds conversations.json.":
		"Exportieren Sie Ihre Daten aus ChatGPT und übergeben Sie den Ordner mit conversations.json.",
});

/** The German rendering of what `run` throws. */
async function germanFailure(run: () => unknown): Promise<string> {
	try {
		await run();
	} catch (error) {
		return formatError(error, german);
	}
	throw new Error("expected a failure");
}

describe("round 39 localized CLI failures", () => {
	test("a Gateway TOML without a section", async () => {
		expect(await germanFailure(() => parseGatewayConfigPatch(""))).toBe(
			"Gateway-TOML muss einen beschreibbaren Abschnitt enthalten."
		);
	});

	test("card stdin without a number", async () => {
		expect(await germanFailure(() => parseCardStdin(""))).toBe(
			"stdin muss in der ersten Zeile die Kartennummer und optional in der zweiten den CVC enthalten."
		);
	});

	test("pick under --json stays English for machines", async () => {
		const view = { id: "scout" } as AgentIdentityView;
		const ctx = { flags: { json: true } } as CliContext;
		const pick = () => pickCommand(ctx, view, {} as AgentsArgs);
		expect(await germanFailure(pick)).toBe(
			"'pick' fragt im Terminal. Verwenden Sie für Skripte 'ryu-cli agents access scout available --json'."
		);
		const error = await pick().catch((caught: unknown) => caught);
		expect(errorToJson(error)).toEqual({
			error:
				"'pick' asks on the terminal. For scripts, use 'ryu-cli agents access scout available --json', then add or remove keys.",
		});
	});

	test("migrate export instructions render in the CLI locale", () => {
		const text = SOURCES.chatgpt.needsPath;
		expect(renderLocalized(text, german.tf)).toBe(
			"Exportieren Sie Ihre Daten aus ChatGPT und übergeben Sie den Ordner mit conversations.json."
		);
		expect(text.english).toStartWith("Export your data from ChatGPT");
		expect(localizedTextOf(new Error("x"))).toBeNull();
	});
});
