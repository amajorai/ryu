// packages/core-client/src/troubleshoot-redaction.test.ts
//
// Redaction must not be evaded by Unicode: fullwidth, zero-width-split,
// TAG-smuggled and look-alike-digit values are caught on the folded view before
// a log line, title or description leaves the device, while text with nothing
// to redact keeps its original form.

import { describe, expect, test } from "bun:test";
import {
	buildIssueTitle,
	buildIssueUrl,
	renderTroubleshootMarkdown,
} from "./troubleshoot-issue.ts";
import type { TroubleshootReport } from "./troubleshoot-model.ts";
import { redactDiagnosticText } from "./troubleshoot-redaction.ts";

describe("redactDiagnosticText on disguised values", () => {
	test("redacts a fullwidth email", () => {
		const out = redactDiagnosticText(
			"login failed for ｊａｎｅ．ｄｏｅ＠ｅｘａｍｐｌｅ．ｃｏｍ"
		);
		expect(out).toBe("login failed for [REDACTED EMAIL]");
	});

	test("redacts an email split by a zero-width space", () => {
		const out = redactDiagnosticText("user jane​@example.com rejected");
		expect(out).not.toContain("jane");
		expect(out).not.toContain("example.com");
		expect(out).toContain("[REDACTED EMAIL]");
	});

	test("redacts tokens and keys split or widened to dodge the patterns", () => {
		for (const [input, secret] of [
			["auth ghp_abc​defghijklmnopqrstuvwxyz0123", "defghijklmnop"],
			[
				"key ｓｋ-ｐｒｏｊ-ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒ",
				"abcdefghijklmnop",
			],
			["pass\u{e0020}word=hunter2 retry", "hunter2"],
			["Bearer⁠ abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnop"],
		] as const) {
			const out = redactDiagnosticText(input);
			expect(out).not.toContain(secret);
			expect(out).toContain("[REDACTED");
		}
	});

	test("redacts a public IP written in fullwidth or Arabic-Indic digits", () => {
		expect(redactDiagnosticText("peer ８.８.８.８ refused")).toBe(
			"peer [REDACTED IP] refused"
		);
		expect(redactDiagnosticText("peer ٨.٨.٨.٨ refused")).toBe(
			"peer [REDACTED IP] refused"
		);
		expect(redactDiagnosticText("bind １２７.０.０.１:7980")).toBe(
			"bind １２７.０.０.１:7980"
		);
	});

	test("redacts a fullwidth home path", () => {
		const out = redactDiagnosticText("open ／Users／jane／.ryu／logs");
		expect(out).not.toContain("jane");
		expect(out).toBe("open ~/.ryu/logs");
	});

	test("keeps as-written matches redacted when the folded view is returned", () => {
		const out = redactDiagnosticText(
			"RYU_CORE_TOKEN=abcd1234efgh5678 mail ｊａｎｅ＠example.com peer 8.8.4.4",
			{ homeDir: "/srv/people/jane" }
		);
		for (const secret of ["abcd1234efgh5678", "jane", "8.8.4.4"]) {
			expect(out).not.toContain(secret);
		}
		expect(out).toContain("RYU_CORE_TOKEN=[REDACTED]");
	});

	test("keeps benign Unicode as written and stays idempotent", () => {
		const benign = "エラー: Ｃore 起動失敗 at 127.0.0.1 — retry later";
		expect(redactDiagnosticText(benign)).toBe(benign);
		const once = redactDiagnosticText("ｊａｎｅ＠example.com said​hi");
		expect(redactDiagnosticText(once)).toBe(once);
	});
});

function report(overrides: Partial<TroubleshootReport>): TroubleshootReport {
	return {
		checks: [],
		description: "",
		generatedAt: "2026-11-02T10:00:00.000Z",
		logExcerpt: [],
		machine: [],
		similarIssues: [],
		surface: "cli",
		version: "0.5.1",
		...overrides,
	};
}

test("disguised PII never reaches the issue URL or the saved report", () => {
	const disguised = report({
		description: "crash after login as ｍａｒｙ＠ｅｘａｍｐｌｅ．ｏｒｇ",
		logExcerpt: [
			"ERROR token=ghp_​abcdefghijklmnopqrstuvwxyz0123",
			"WARN peer ９.９.９.９ dropped",
		],
		machine: [["Data dir", "／home／mary／.ryu"]],
	});
	const url = [
		...new URL(
			buildIssueUrl(disguised, { fallbackUnit: "apps/cli" })
		).searchParams.values(),
	].join("\n");
	const markdown = renderTroubleshootMarkdown(disguised);
	for (const output of [url, markdown]) {
		for (const leaked of [
			"mary",
			"ｍａｒｙ",
			"abcdefghijklmnop",
			"9.9.9.9",
			"９.９.９.９",
		]) {
			expect(output).not.toContain(leaked);
		}
		expect(output).toContain("[REDACTED EMAIL]");
		expect(output).toContain("[REDACTED IP]");
	}
});

test("a headline title is redacted before it is clipped, so no token prefix survives the cut", () => {
	// The 90-character cut lands 15 characters into the token: too short for
	// the token rule, so clipping first would put that prefix in the title.
	const title = "Core reachable";
	const lead = "x".repeat(90 - title.length - ": ghp_".length - 15);
	const token = `ghp_${"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}`;
	const clipped = report({
		checks: [
			{
				id: "core.reachable",
				status: "fail",
				title,
				detail: `${lead} ${token}`,
			},
		],
	});
	for (const output of [
		buildIssueTitle(clipped),
		new URL(
			buildIssueUrl(clipped, { fallbackUnit: "apps/cli" })
		).searchParams.get("title") ?? "",
	]) {
		expect(output).not.toContain("ABCDEFGHIJK");
		expect(output).toContain("[REDACTED TOKEN]");
	}
});

test("a relocated home in the headline is removed before the title is clipped", () => {
	const homeDir = "/srv/accounts/mary-the-maintainer";
	const clipped = report({
		checks: [
			{
				id: "data.dir",
				status: "fail",
				title: "Data dir writable",
				detail: `${"y".repeat(60)} ${homeDir}/.ryu is read-only`,
			},
		],
	});
	const url = new URL(
		buildIssueUrl(clipped, { fallbackUnit: "apps/cli", homeDir })
	);
	// The cut lands inside the home path: only its first ten characters would
	// survive a clip-then-redact order, and the exact-path rule would miss them.
	expect(url.searchParams.get("title")).not.toContain("/srv/acc");
	expect(buildIssueTitle(clipped, { homeDir })).not.toContain("/srv/acc");
});

test("a long description title is clipped on code points, never splitting a pair", () => {
	const title = buildIssueTitle(
		report({ description: `${"a".repeat(86)}😀😀😀😀😀😀` })
	);
	expect(title).toBe(`${"a".repeat(86)}😀…`);
	expect(title.isWellFormed()).toBe(true);
});
