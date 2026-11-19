// `ryu-cli troubleshoot` fix lines built from values (token, data-dir
// ownership, other profile) under a Japanese translator: the check keeps the
// English sentence for --json and the Markdown report, and the human output
// renders the catalog's whole translated sentence with the values filled in.
import { describe, expect, mock, test } from "bun:test";
import type { TroubleshootReport } from "@ryuhq/core-client/troubleshoot";
import { createCliTranslator } from "../i18n/translate.ts";
import type { TroubleshootHost } from "./troubleshoot-host.ts";

const TOKEN_FIX =
	"Set RYU_CORE_TOKEN to the node's token, or pick a saved node with `{commandName} node use {name}`.";
const CHOWN_FIX =
	'sudo chown -R "$(whoami)" {shown} (it was likely created by a root install), or set RYU_DIR.';
const NETWORK_FIX =
	"Check your internet connection or proxy (HTTPS_PROXY); downloads need it too.";

const japanese = createCliTranslator("ja", {
	"Fix: {fix}": "修正方法: {fix}",
	[TOKEN_FIX]:
		"RYU_CORE_TOKEN にノードのトークンを設定するか、`{commandName} node use {name}` で保存済みのノードを選んでください。",
	[CHOWN_FIX]:
		'sudo chown -R "$(whoami)" {shown}（root でのインストールで作成された可能性があります）を実行するか、RYU_DIR を設定してください。',
	[NETWORK_FIX]:
		"インターネット接続またはプロキシ (HTTPS_PROXY) を確認してください。ダウンロードにも必要です。",
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
const { renderHuman } = await import("./troubleshoot-report.ts");
const { tokenFix } = await import("./troubleshoot-probes.ts");
const { checkDataDir } = await import("./troubleshoot-local-checks.ts");

const unused = () => Promise.reject(new Error("not used"));
const host: TroubleshootHost = {
	arch: "x64",
	commandName: "ryu-cli",
	cpu: { count: 8, model: null },
	dataDir: "/srv/ryu",
	fetch: Object.assign(unused, { preconnect: fetch.preconnect }),
	homeDir: "/home/me",
	makeDir: unused,
	memory: { freeBytes: 1, totalBytes: 2 },
	now: () => new Date(0),
	openUrl: unused,
	osRelease: "6.0",
	platform: "linux",
	probeDir: () =>
		Promise.resolve({ exists: true, freeBytes: null, writable: false }),
	probePort: unused,
	readTail: unused,
	resolveBinary: () => null,
	runtime: "bun",
	startCore: unused,
	tempDir: "/tmp",
	writeFile: unused,
};

function render(checks: TroubleshootReport["checks"]): string {
	return renderHuman(
		{
			fixes: [],
			issueUrl: "https://github.com/amajorai/ryu/issues/new",
			opened: false,
			report: {
				checks,
				description: "x",
				generatedAt: "2030-01-01T00:00:00Z",
				logExcerpt: [],
				machine: [["OS", "linux"]],
				similarIssues: [],
				surface: "cli",
				version: "1.0.0",
			},
			reportPath: null,
			similarIssuesError: null,
		},
		host
	);
}

describe("troubleshoot fix lines with values", () => {
	test("the token fix stays English on the check and renders in Japanese", () => {
		const fix = tokenFix(host);
		expect(fix).toBe(
			"Set RYU_CORE_TOKEN to the node's token, or pick a saved node with `ryu-cli node use <name>`."
		);
		const out = render([
			{ detail: "x", fix, id: "core.auth", status: "fail", title: "T" },
		]);
		expect(out).toContain(
			"修正方法: RYU_CORE_TOKEN にノードのトークンを設定するか、`ryu-cli node use <name>` で保存済みのノードを選んでください。"
		);
	});

	test("the data-dir ownership fix carries its path into the translation", async () => {
		const state = { checks: [], fixes: [], machine: [] };
		await checkDataDir(state, host, {
			description: "",
			dryRun: false,
			fix: false,
			json: false,
			offline: true,
			open: false,
		});
		const check = state.checks.find(
			(entry: { id: string }) => entry.id === "data-dir"
		) as TroubleshootReport["checks"][number] | undefined;
		expect(check?.fix).toBe(
			'sudo chown -R "$(whoami)" /srv/ryu (it was likely created by a root install), or set RYU_DIR.'
		);
		const out = render(check ? [check] : []);
		expect(out).toContain(
			'修正方法: sudo chown -R "$(whoami)" /srv/ryu（root でのインストールで作成された可能性があります）を実行するか、RYU_DIR を設定してください。'
		);
	});

	test("a static fix sentence is an exact catalog entry", () => {
		const out = render([
			{
				detail: "x",
				fix: NETWORK_FIX,
				id: "update",
				status: "warn",
				title: "Updates",
			},
		]);
		expect(out).toContain(
			"修正方法: インターネット接続またはプロキシ (HTTPS_PROXY) を確認してください。ダウンロードにも必要です。"
		);
	});
});
