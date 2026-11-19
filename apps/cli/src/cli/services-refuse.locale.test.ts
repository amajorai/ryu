// `ryu services` usage refusals under a Japanese translator: each refusal is a
// whole catalog sentence with the flag filled in, behind the literal
// `ryu-cli services:` prefix.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const DANGLING =
	"{flag} before `services` has no value. Put it after the command with its value, for example: ryu-cli services <service> <command> {flag} <value>";
const NOT_FORWARDED =
	"{flags} before `services` is not a ryu-services global flag, so it is not forwarded. Put it after the command:";
const VERSION_ONLY =
	"--version takes no service or command. Run: ryu-cli services --version";
const KEY_NOTE =
	"(replace <key> with your key, or set the service's key env var instead)";

const japanese = createCliTranslator("ja", {
	[DANGLING]:
		"`services` の前の {flag} に値がありません。値と一緒にコマンドの後ろに置いてください。例: ryu-cli services <service> <command> {flag} <value>",
	[NOT_FORWARDED]:
		"`services` の前の {flags} は ryu-services のグローバルフラグではないため、転送されません。コマンドの後ろに置いてください:",
	[VERSION_ONLY]:
		"--version にはサービスやコマンドを指定できません。実行: ryu-cli services --version",
	[KEY_NOTE]:
		"(<key> を自分のキーに置き換えるか、代わりにサービスのキー環境変数を設定してください)",
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
const { runServicesFromRyu } = await import("./services.ts");

async function refusal(
	leading: string[],
	rawArgs: string[]
): Promise<{ code: number; err: string }> {
	let err = "";
	const code = await runServicesFromRyu(leading, rawArgs, {
		io: {
			err: (chunk: string) => {
				err += chunk;
			},
			out: () => undefined,
		} as never,
	});
	return { code, err };
}

describe("ryu services refusals under a Japanese translator", () => {
	test("a value flag with no value", async () => {
		const { code, err } = await refusal(["--base-url"], []);
		expect(code).toBe(2);
		expect(err).toBe(
			"ryu-cli services: `services` の前の --base-url に値がありません。値と一緒にコマンドの後ろに置いてください。例: ryu-cli services <service> <command> --base-url <value>\n"
		);
	});

	test("--version with a command", async () => {
		const { err } = await refusal(["--version"], ["mail", "send"]);
		expect(err).toBe(
			"ryu-cli services: --version にはサービスやコマンドを指定できません。実行: ryu-cli services --version\n"
		);
	});

	test("a non-global flag is moved, with the key note", async () => {
		const { err } = await refusal(
			["--bogus", "--api-key", "secret"],
			["mail", "send"]
		);
		const lines = err.split("\n");
		expect(lines[0]).toContain(
			"は ryu-services のグローバルフラグではないため、転送されません。コマンドの後ろに置いてください:"
		);
		expect(lines[0]).toStartWith("ryu-cli services: `services` の前の ");
		expect(err).toContain(
			"  (<key> を自分のキーに置き換えるか、代わりにサービスのキー環境変数を設定してください)"
		);
		expect(err).not.toContain("secret");
	});
});
