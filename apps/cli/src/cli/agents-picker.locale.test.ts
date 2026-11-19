// `ryu-cli agents access <id> available|pick` printed its group headings,
// section titles, notices and prompts as raw English, and joined the titles of
// failed sections with an English comma. The stub catalog stands in for the
// Japanese pack so the test pins the call sites, not the shipped wording.
import { describe, expect, mock, test } from "bun:test";
import type { AvailableAccounts } from "../core/agentAccountCatalog.ts";
import { createCliTranslator } from "../i18n/translate.ts";
import type { AgentIdentityView } from "./agents-core.ts";

const japanese = createCliTranslator("ja", {
	"Your accounts": "あなたのアカウント",
	"Model providers": "モデルプロバイダー",
	"MCP sign-ins": "MCP サインイン",
	"Couldn't load your MCP servers.": "MCP サーバーを読み込めませんでした。",
	"No provider keys yet.": "プロバイダーキーはまだありません。",
	"Its own accounts: not shown, because this agent acts as you and has no accounts of its own.":
		"独自のアカウント: 表示されません。",
	"Allowed but not listed now": "許可済みだが現在は一覧にない",
	"Not listed now": "現在は一覧にない",
	yes: "はい",
	Expired: "期限切れ",
	"Allow or remove one with: ryu-cli agents access {id} <add|remove> <key>…, or tick them with: ryu-cli agents access {id} pick":
		"許可または削除: ryu-cli agents access {id} <add|remove> <key>…、選択: ryu-cli agents access {id} pick",
	"Toggle rows (e.g. 1 3-5), or type {all}, {none}, {unlimited}, {save} or {cancel}:":
		"行を切り替えます (例: 1 3-5)。または {all}、{none}、{unlimited}、{save}、{cancel} と入力します:",
	"Not an account key Core accepts: {keys}. Nothing was saved.":
		"Core が受け付けるアカウントキーではありません: {keys}。何も保存されませんでした。",
	"Keys look like:": "キーの形式:",
	"Couldn't load {names}, so a limit started now would also take those accounts away. Nothing was changed; try again once they load.":
		"{names} を読み込めませんでした。何も変更されていません。",
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
const { describeAvailable, pickQuestion, renderPickList } = await import(
	"./agents-picker.ts"
);
const { requireKeys } = await import("./agents-save.ts");
const { accountLimitStartBlocked, accountPickerRows } = await import(
	"../core/agentAccountCatalog.ts"
);

const VIEW: AgentIdentityView = {
	accountAccess: ["gateway:openai", "vault:gone"],
	engine: "acp:pi",
	id: "scout",
	identityMode: "managed",
	locked: false,
	name: "Scout",
	pendingIdentityMode: null,
	updatedAt: null,
};

const ACCOUNTS: AvailableAccounts = {
	hiddenGroups: [
		"Its own accounts: not shown, because this agent acts as you and has no accounts of its own.",
	],
	sections: [
		{
			empty: "No provider keys yet.",
			error: null,
			id: "model-providers",
			owner: "yours",
			rows: [
				{
					detail: null,
					key: "gateway:openai",
					section: "model-providers",
					status: "Expired",
					title: "OpenAI",
				},
			],
			title: "Model providers",
		},
		{
			empty: "",
			error: "Couldn't load your MCP servers.",
			id: "mcp-sign-ins",
			owner: "yours",
			rows: [],
			title: "MCP sign-ins",
		},
	],
};

describe("account picker under Japanese", () => {
	test("the pick list translates headings, titles, notices and hidden groups", () => {
		const rows = accountPickerRows(ACCOUNTS, VIEW.accountAccess);
		const text = renderPickList(VIEW, ACCOUNTS, rows, VIEW.accountAccess);
		expect(text).toContain("あなたのアカウント");
		expect(text).toContain("モデルプロバイダー");
		expect(text).toContain("OpenAI (期限切れ)");
		expect(text).toContain(
			"MCP サインイン: MCP サーバーを読み込めませんでした。"
		);
		expect(text).toContain("独自のアカウント: 表示されません。");
		expect(text).toContain("許可済みだが現在は一覧にない");
		for (const english of [
			"Your accounts",
			"Model providers",
			"Couldn't load",
			"Allowed but not listed now",
			"Expired",
		]) {
			expect(text).not.toContain(english);
		}
	});

	test("the available table and its hint read in Japanese", () => {
		const text = describeAvailable(VIEW, ACCOUNTS);
		expect(text).toContain("はい");
		expect(text).toContain("現在は一覧にない");
		expect(text).toContain(
			"許可または削除: ryu-cli agents access scout <add|remove> <key>…"
		);
		expect(text).not.toContain("Not listed now");
		expect(text).not.toContain("Allow or remove one with");
	});

	test("the prompt is translated but keeps the English words it parses", () => {
		const question = pickQuestion();
		expect(question).toBe(
			"\n行を切り替えます (例: 1 3-5)。または all、none、unlimited、save、cancel と入力します: "
		);
	});

	test("a blocked limit names the failed sections as a Japanese list", () => {
		const failed: AvailableAccounts = {
			hiddenGroups: [],
			sections: [
				{ ...ACCOUNTS.sections[1], title: "MCP sign-ins" },
				{
					...ACCOUNTS.sections[1],
					id: "model-providers",
					title: "Model providers",
				},
			] as AvailableAccounts["sections"],
		};
		const names = new Intl.ListFormat("ja", { type: "conjunction" }).format([
			"MCP サインイン",
			"モデルプロバイダー",
		]);
		expect(accountLimitStartBlocked(failed)).toBe(
			`${names} を読み込めませんでした。何も変更されていません。`
		);
	});

	test("an invalid key names every bad key as a Japanese list", () => {
		const names = new Intl.ListFormat("ja", { type: "conjunction" }).format([
			"openai",
			"bogus",
		]);
		expect(() => requireKeys(["openai", "bogus"], "usage")).toThrow(
			`Core が受け付けるアカウントキーではありません: ${names}。何も保存されませんでした。\nキーの形式:\n  `
		);
	});
});
