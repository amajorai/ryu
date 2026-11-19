// `ryu-cli troubleshoot` human output under a Japanese translator: section
// headers, the fix and tip lines, the count summary and the closing prompts are
// whole catalog sentences. The saved Markdown and issue body stay English.
import { describe, expect, mock, test } from "bun:test";
import type { TroubleshootReport } from "@ryuhq/core-client/troubleshoot";
import { createCliTranslator } from "../i18n/translate.ts";
import type { TroubleshootHost } from "./troubleshoot-host.ts";

const COUNTS =
	"{pass, plural, one {# passed} other {# passed}} · {warn, plural, one {# warning} other {# warnings}} · {fail, plural, one {# failed} other {# failed}} · {skip, plural, one {# skipped} other {# skipped}}";
const TIP =
	'Tip: describe the problem to improve the search and the report: {command} troubleshoot "what went wrong"';

// Pin the CLI to a Japanese stub catalog before the report module loads, the
// way LANG=ja_JP.UTF-8 does at startup; the shipped catalog has no entries
// for these sentences yet.
const japanese = createCliTranslator("ja", {
	Machine: "マシン",
	Fixes: "修正",
	Checks: "チェック",
	"Fix: {fix}": "修正方法: {fix}",
	[COUNTS]:
		"成功 {pass, plural, other {# 件}} · 警告 {warn, plural, other {# 件}} · 失敗 {fail, plural, other {# 件}} · スキップ {skip, plural, other {# 件}}",
	"Still stuck after the fixes above? File a bug report. The form is prefilled; review it before you submit:":
		"上の修正でも解決しない場合は、バグを報告してください。フォームは入力済みです。送信前に確認してください:",
	"Every check passed. If something is still wrong, describe it and file a bug report:":
		"すべてのチェックに合格しました。まだ問題がある場合は、内容を書いてバグを報告してください:",
	"(Opened in your browser.)": "（ブラウザーで開きました。）",
	"Core reachable": "Core に到達可能",
	// The catalog's bare "Memory" is Ryu's AI memory, not RAM.
	Memory: "記憶",
	Gateway: "Gateway",
	"Core answered on {url}.": "Core が {url} で応答しました。",
	"Start Core with {command}.": "{command} で Core を起動してください。",
	[TIP]:
		'ヒント: 問題を書くと検索とレポートの精度が上がります: {command} troubleshoot "何が起きたか"',
	"Memory (RAM)": "メモリ (RAM)",
	Profile: "プロファイル",
	"{total} total, {free} free": "合計 {total}、空き {free}",
	"{variables} is set": "{variables} が設定されています",
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
const { machineInfo, renderHuman } = await import("./troubleshoot-report.ts");

const unused = () => Promise.reject(new Error("not used by renderHuman"));
const host: TroubleshootHost = {
	arch: "x64",
	commandName: "ryu-cli",
	cpu: { count: 8, model: null },
	dataDir: "/home/me/.ryu",
	fetch: Object.assign(unused, { preconnect: fetch.preconnect }),
	homeDir: "/home/me",
	makeDir: unused,
	memory: { freeBytes: 1, totalBytes: 2 },
	now: () => new Date(0),
	openUrl: unused,
	osRelease: "6.0",
	platform: "linux",
	probeDir: unused,
	probePort: unused,
	readTail: unused,
	resolveBinary: () => null,
	runtime: "bun",
	startCore: unused,
	tempDir: "/tmp",
	writeFile: unused,
};

function report(checks: TroubleshootReport["checks"]): TroubleshootReport {
	return {
		checks,
		description: "",
		generatedAt: "2030-01-01T00:00:00Z",
		logExcerpt: [],
		machine: [["OS", "linux 6.0 (x64)"]],
		similarIssues: [],
		surface: "cli",
		version: "1.0.0",
	};
}

const ISSUE_URL = "https://github.com/amajorai/ryu/issues/new";

describe("troubleshoot human output under a Japanese translator", () => {
	test("headers, fix line, counts and the stuck prompt are Japanese", () => {
		const out = renderHuman(
			{
				fixes: ["restarted Core"],
				issueUrl: ISSUE_URL,
				opened: false,
				report: report([
					{ detail: "ok", id: "a", status: "pass", title: "A" },
					{
						detail: "down",
						fix: "ryu-cli start",
						id: "b",
						status: "fail",
						title: "B",
					},
					{ detail: "slow", id: "c", status: "warn", title: "C" },
					{ detail: "slow", id: "d", status: "warn", title: "D" },
				]),
				reportPath: null,
				similarIssuesError: null,
			},
			host
		);
		const lines = out.split("\n");
		expect(lines).toContain("マシン");
		expect(lines).toContain("修正");
		expect(lines).toContain("チェック");
		expect(out).toContain("修正方法: ryu-cli start");
		expect(lines).toContain(
			"成功 1 件 · 警告 2 件 · 失敗 1 件 · スキップ 0 件"
		);
		expect(out).toContain(
			"上の修正でも解決しない場合は、バグを報告してください。"
		);
		expect(out).toContain(
			'  ヒント: 問題を書くと検索とレポートの精度が上がります: ryu-cli troubleshoot "何が起きたか"'
		);
		expect(out).not.toMatch(/Machine|Checks|Fix:|passed|warnings|Tip:/u);
	});

	test("a clean run gets the Japanese all-passed prompt and browser note", () => {
		const out = renderHuman(
			{
				fixes: [],
				issueUrl: ISSUE_URL,
				opened: true,
				report: report([{ detail: "ok", id: "a", status: "pass", title: "A" }]),
				reportPath: null,
				similarIssuesError: null,
			},
			host
		);
		expect(out).toContain("成功 1 件 · 警告 0 件 · 失敗 0 件 · スキップ 0 件");
		expect(out).toContain("すべてのチェックに合格しました。");
		expect(out).toContain("  （ブラウザーで開きました。）");
		expect(out).not.toContain("Every check passed");
	});
});

describe("troubleshoot check rows under a Japanese translator", () => {
	test("titles and details are translated and columns align by width", () => {
		const out = renderHuman(
			{
				fixes: [],
				issueUrl: ISSUE_URL,
				opened: false,
				report: report([
					{
						detail: "Core answered on http://127.0.0.1:8980.",
						fix: "Start Core with ryu-cli start.",
						id: "core",
						status: "warn",
						title: "Core reachable",
					},
					{ detail: "ok", id: "gw", status: "pass", title: "Gateway" },
					{ detail: "16 GB", id: "memory", status: "info", title: "Memory" },
				]),
				reportPath: null,
				similarIssuesError: null,
			},
			host
		);
		const lines = out.split("\n");
		const core = lines.find((line) => line.includes("Core に到達可能"));
		const gateway = lines.find((line) => line.includes("Gateway  "));
		expect(core).toContain("Core が http://127.0.0.1:8980 で応答しました。");
		expect(out).toContain(
			"修正方法: ryu-cli start で Core を起動してください。"
		);
		// Both details start in the same terminal column.
		const column = (line: string | undefined, detail: string) =>
			Bun.stringWidth((line ?? "").slice(0, (line ?? "").indexOf(detail)));
		expect(column(core, "Core が")).toBe(column(gateway, "ok"));
		expect(out).not.toContain("Core reachable");
		expect(out).not.toContain("Core answered");
		// The RAM check keeps its English title rather than the AI-memory sense.
		expect(out).toContain("Memory");
		expect(out).not.toContain("記憶");
	});
});

describe("troubleshoot human output in English", () => {
	test("counts pluralize per status", () => {
		const english = createCliTranslator(null, null);
		expect(english.tf(COUNTS, { fail: 1, pass: 3, skip: 2, warn: 1 })).toBe(
			"3 passed · 1 warning · 1 failed · 2 skipped"
		);
		expect(english.tf(COUNTS, { fail: 0, pass: 1, skip: 0, warn: 2 })).toBe(
			"1 passed · 2 warnings · 0 failed · 0 skipped"
		);
	});
});

describe("troubleshoot machine rows under a Japanese translator", () => {
	test("labels and built values render in Japanese; the report stays English", () => {
		const ctx = {
			env: { HTTPS_PROXY: "http://proxy" },
			target: { url: "http://127.0.0.1:8980" },
		} as unknown as Parameters<typeof machineInfo>[1];
		const machine = machineInfo(host, ctx);
		const memory = machine.find(([label]) => label === "Memory");
		expect(memory?.[1]).toMatch(/ total, .* free$/u);
		expect(machine).toContainEqual(["Proxy", "HTTPS_PROXY/HTTP_PROXY is set"]);
		const out = renderHuman(
			{
				fixes: [],
				issueUrl: ISSUE_URL,
				opened: true,
				report: { ...report([]), machine },
				reportPath: null,
				similarIssuesError: null,
			},
			host
		);
		expect(out).toMatch(/メモリ \(RAM\) +合計 .*、空き /u);
		expect(out).toContain("HTTPS_PROXY/HTTP_PROXY が設定されています");
		expect(out).toMatch(/\n {2}プロファイル +\S/u);
		expect(out).not.toContain("記憶");
	});
});
