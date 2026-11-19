// `ryu-cli connect <agent>` closes with how to load the new MCP server. That
// hint was spliced into the translated summary as raw English; it now goes
// through the catalog. The stub catalog stands in for the Japanese pack.

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { createCliTranslator } from "../i18n/translate.ts";

const RELOAD = "Restart Gemini CLI to load it.";
const japanese = createCliTranslator("ja", {
	[RELOAD]: "読み込むには、Gemini CLI を再起動してください。",
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
const { runCli } = await import("../cli/dispatch.ts");

let home = "";
const target: ApiTarget = {
	token: "ryu_test_token",
	url: "http://127.0.0.1:7980",
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ryu-agent-connect-locale-"));
	mkdirSync(join(home, "bin"));
});

afterEach(() => {
	rmSync(home, { force: true, recursive: true });
});

test("the reload hint after connecting reads in Japanese", async () => {
	let out = "";
	const code = await runCli(["connect", "gemini"], {
		env: {
			HOME: home,
			PATH: join(home, "bin"),
			RYU_CLI_CONFIG_DIR: join(home, "state"),
			USERPROFILE: home,
		},
		fetch: () => Promise.reject(new Error("no network in tests")),
		io: {
			err: () => undefined,
			out: (text) => {
				out += text;
			},
		},
		target,
	});
	expect(code).toBe(0);
	expect(out).toContain("読み込むには、Gemini CLI を再起動してください。");
	expect(out).not.toContain(RELOAD);
});
