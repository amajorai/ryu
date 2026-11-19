// The manual-paste fallback under a Japanese translator: the reason a config
// cannot be edited (an English error message) renders in the CLI language
// inside the translated wrapper, while --json keeps the English reason.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const WRAPPER = "{reason}\nNothing was written. Add this to {configPath}:";
const REASON_TEMPLATE = "{label} is not a TOML table.";

const japanese = createCliTranslator("ja", {
	[WRAPPER]:
		"{reason}\n何も書き込まれていません。これを {configPath} に追加してください:",
	[REASON_TEMPLATE]: "{label} は TOML テーブルではありません。",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "ja",
	CLI_LOCALE: "ja",
	CLI_TRANSLATOR: japanese,
	createCliTranslator,
	tf: japanese.tf,
	tr: japanese.tr,
	trMessage: japanese.trMessage,
	translateProps: japanese.translateProps,
}));
const { printSnippet } = await import("./agentCommands-shared.ts");
const { findAgent } = await import("./agentConnect.ts");
type Context = Parameters<typeof printSnippet>[0];

function capture(json: boolean) {
	const out: string[] = [];
	const err: string[] = [];
	const ctx = {
		flags: { json, print: false },
		io: {
			err: (text: string) => err.push(text),
			out: (text: string) => out.push(text),
		},
	} as unknown as Context;
	return { ctx, err, out };
}

function snippetFor(json: boolean) {
	const agent = findAgent("codex");
	if (!agent) {
		throw new Error("codex agent missing");
	}
	const entry = agent.buildEntry({
		mcpUrl: "http://127.0.0.1:7777/mcp/ryu",
		token: null,
		tokenMode: "env",
	});
	const run = capture(json);
	const code = printSnippet(
		run.ctx,
		agent,
		entry,
		"/home/me/.codex/config.toml",
		"env",
		"/home/me/.codex/config.toml is not a TOML table.",
		null
	);
	return { code, ...run };
}

describe("printSnippet reason under a Japanese translator", () => {
	test("human output translates the reason inside the wrapper", () => {
		const { code, err } = snippetFor(false);
		expect(code).toBe(1);
		expect(err.join("")).toContain(
			"/home/me/.codex/config.toml は TOML テーブルではありません。\n何も書き込まれていません。"
		);
	});

	test("--json keeps the English reason", () => {
		const { out } = snippetFor(true);
		const payload = JSON.parse(out.join(""));
		expect(payload.reason).toBe(
			"/home/me/.codex/config.toml is not a TOML table."
		);
	});
});
