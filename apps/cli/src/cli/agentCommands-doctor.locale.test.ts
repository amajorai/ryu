// `ryu doctor agents` human output under a Japanese translator: status words,
// notes, fixes and the endpoint detail render as whole catalog sentences, while
// the report object (what --json prints) keeps the English text.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const COMMENTS_NOTE =
	"{configPath} has comments, so {BIN} connect/disconnect cannot edit it; change the '{MCP_SERVER_NAME}' entry by hand.";
const UNREADABLE_FIX =
	"Fix {configPath}, or run {BIN} connect {agentId} --print and add the entry by hand";

const japanese = createCliTranslator("ja", {
	"Ryu MCP endpoint {url}: {status} ({detail})":
		"Ryu MCP エンドポイント {url}: {status} ({detail})",
	"the node token was rejected": "ノードのトークンが拒否されました",
	"Start Ryu (the desktop app, or run ryu-cli once)":
		"Ryu を起動してください (デスクトップアプリ、または ryu-cli を一度実行)",
	broken: "破損",
	connected: "接続済み",
	"not connected": "未接続",
	"other node": "その他のノード",
	unreadable: "読み取り不可",
	"configured (Core down)": "設定済み (Core 停止中)",
	Notes: "メモ",
	Fixes: "修正",
	"The entry sends no Authorization header.":
		"このエントリは Authorization ヘッダーを送信しません。",
	"the node token is stored inline in its config":
		"ノードのトークンが設定にそのまま保存されています",
	[COMMENTS_NOTE]:
		"{configPath} にはコメントがあるため、{BIN} connect/disconnect では編集できません。'{MCP_SERVER_NAME}' エントリを手動で変更してください。",
	[UNREADABLE_FIX]:
		"{configPath} を修正するか、{BIN} connect {agentId} --print を実行してエントリを手動で追加してください",
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
const { probeMcpEndpoint, renderAgentsDoctorReport } = await import(
	"./agentCommands-doctor.ts"
);
const { localize } = await import("./localizedText.ts");
type Report = Parameters<typeof renderAgentsDoctorReport>[0];
type Agent = Report["agents"][number];

function agent(overrides: Partial<Agent>): Agent {
	return {
		binary: null,
		configPath: "/home/me/.agent.json",
		endpoint: null,
		fix: null,
		id: "agent",
		label: "Agent",
		managedByRyu: false,
		notes: [],
		status: "not-connected",
		tokenMode: null,
		url: null,
		...overrides,
	};
}

describe("ryu doctor agents under a Japanese translator", () => {
	test("status words, notes, fixes and the endpoint line are Japanese", () => {
		const report: Report = {
			coreUrl: "http://127.0.0.1:7777",
			endpoint: {
				detail: "the node token was rejected",
				status: "unauthorized",
				url: "http://127.0.0.1:7777/mcp/x",
			},
			agents: [
				agent({ id: "a", status: "connected", tokenMode: "inline" }),
				agent({
					id: "b",
					notes: [
						localize(COMMENTS_NOTE, {
							configPath: "/home/me/.b.jsonc",
							BIN: "ryu",
							MCP_SERVER_NAME: "ryu",
						}).english,
					],
					status: "unreadable",
					fix: localize(UNREADABLE_FIX, {
						configPath: "/home/me/.b.jsonc",
						BIN: "ryu",
						agentId: "b",
					}).english,
				}),
				agent({
					id: "c",
					notes: ["The entry sends no Authorization header."],
					status: "broken",
				}),
				agent({ id: "d", status: "other-node" }),
				agent({ id: "e", status: "unverified" }),
				agent({ id: "f" }),
			],
		};
		const out = renderAgentsDoctorReport(report);
		const lines = out.split("\n");
		expect(out).toContain(
			"Ryu MCP エンドポイント http://127.0.0.1:7777/mcp/x: unauthorized (ノードのトークンが拒否されました)"
		);
		for (const word of [
			"接続済み",
			"読み取り不可",
			"破損",
			"その他のノード",
			"設定済み (Core 停止中)",
			"未接続",
		]) {
			expect(out).toContain(word);
		}
		expect(lines).toContain("メモ");
		expect(lines).toContain("修正");
		expect(lines).toContain(
			"  a: ノードのトークンが設定にそのまま保存されています"
		);
		expect(lines).toContain(
			"  b: /home/me/.b.jsonc にはコメントがあるため、ryu connect/disconnect では編集できません。'ryu' エントリを手動で変更してください。"
		);
		expect(lines).toContain(
			"  c: このエントリは Authorization ヘッダーを送信しません。"
		);
		expect(lines).toContain(
			"  b: /home/me/.b.jsonc を修正するか、ryu connect b --print を実行してエントリを手動で追加してください"
		);
		expect(out).not.toMatch(/Notes|Fixes|not connected|has comments/u);
	});

	test("an unreachable endpoint's fix is the Japanese start hint", () => {
		const out = renderAgentsDoctorReport({
			agents: [],
			coreUrl: "http://127.0.0.1:7777",
			endpoint: { detail: "down", status: "unreachable", url: "http://x" },
		});
		expect(out).toContain(
			"  endpoint: Ryu を起動してください (デスクトップアプリ、または ryu-cli を一度実行)"
		);
	});

	test("a rejected token keeps the English detail for --json", async () => {
		const ctx = {
			fetch: () => Promise.resolve(new Response("{}", { status: 401 })),
		} as unknown as Parameters<typeof probeMcpEndpoint>[0];
		const probe = await probeMcpEndpoint(ctx, "http://x/mcp/a", "token");
		expect(probe.detail).toBe("the node token was rejected");
		expect(probe.status).toBe("unauthorized");
	});
});
