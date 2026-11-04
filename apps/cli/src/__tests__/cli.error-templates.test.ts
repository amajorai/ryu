// Usage errors that name a value are whole ICU messages (`tf`), so the CLI's
// language pack translates the sentence around the value instead of leaving
// an untranslatable `${…}` template.
import { describe, expect, test } from "bun:test";

import { requireAgent } from "../cli/agentCommands-shared.ts";
import { parseMigrateArgs } from "../cli/migrate-args.ts";
import type { CliContext } from "../cli/types.ts";
import { createCliTranslator } from "../i18n/translate.ts";

const UNKNOWN_AGENT = "Unknown coding agent '{id}'. Supported: {agents}.";
const UNKNOWN_KIND = 'Unknown kind "{part}". Use: {kinds}.';

function thrownMessage(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected a thrown error");
}

describe("CLI error templates", () => {
	test("name the unknown kind and the accepted kinds", () => {
		const message = thrownMessage(() =>
			parseMigrateArgs(["openclaw", "--only", "bogus"])
		);
		expect(message).toStartWith('Unknown kind "bogus". Use: ');
		expect(message).toContain("skill");
		expect(message).not.toContain("{");
	});

	test("name the unknown coding agent and the supported ids", () => {
		const ctx = { args: ["no-such-agent"] } as unknown as CliContext;
		const message = thrownMessage(() => requireAgent(ctx, "ryu-cli connect"));
		expect(message).toStartWith(
			"Unknown coding agent 'no-such-agent'. Supported: "
		);
		expect(message).not.toContain("{");
	});

	test("translate the whole sentence around the values", () => {
		const german = createCliTranslator("de", {
			[UNKNOWN_AGENT]:
				"Unbekannter Coding-Agent „{id}“. Unterstützt: {agents}.",
			[UNKNOWN_KIND]: "Unbekannte Art „{part}“. Erlaubt: {kinds}.",
		});
		expect(german.tf(UNKNOWN_AGENT, { agents: "claude, codex", id: "x" })).toBe(
			"Unbekannter Coding-Agent „x“. Unterstützt: claude, codex."
		);
		expect(german.tf(UNKNOWN_KIND, { kinds: "skill", part: "bogus" })).toBe(
			"Unbekannte Art „bogus“. Erlaubt: skill."
		);
	});
});
