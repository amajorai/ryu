import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { refusal } from "./connect-refusal.ts";
import { ConnectError } from "./connectClient.ts";
import { localize } from "./localizedText.ts";
import type { CliContext } from "./types.ts";

function context(json: boolean): { ctx: CliContext; err: () => string } {
	let err = "";
	const ctx = {
		flags: { json },
		io: {
			out: () => undefined,
			err: (text: string) => {
				err += text;
			},
		},
	} as unknown as CliContext;
	return { ctx, err: () => err };
}

const german = createCliTranslator("de", {
	"Error: {message}": "Fehler: {message}",
	"The answer is too large.": "Die Antwort ist zu groß.",
	"Invalid platform: {slug}": "Ungültige Plattform: {slug}",
});

describe("connect refusal", () => {
	test("the client's own reason renders in the locale; --json stays English", () => {
		const error = new ConnectError(
			413,
			"answer_too_large",
			localize("The answer is too large.")
		);
		const human = context(false);
		expect(refusal(human.ctx, error, german)).toBe(1);
		expect(human.err()).toBe("Fehler: Die Antwort ist zu groß.\n");
		const machine = context(true);
		refusal(machine.ctx, error, german);
		expect(JSON.parse(machine.err()).error).toBe("The answer is too large.");
	});

	test("a filled template and a server's own text", () => {
		const invalid = context(false);
		refusal(
			invalid.ctx,
			new ConnectError(
				400,
				"x",
				localize("Invalid platform: {slug}", { slug: "../x" })
			),
			german
		);
		expect(invalid.err()).toBe("Fehler: Ungültige Plattform: ../x\n");
		const server = context(false);
		refusal(
			server.ctx,
			new ConnectError(401, "unauthorized", "unauthorized"),
			german
		);
		expect(server.err()).toBe("Fehler: unauthorized\n");
	});
});
