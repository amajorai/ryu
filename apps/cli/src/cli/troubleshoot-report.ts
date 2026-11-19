// Machine summary, similar-issue search, the saved report, and human output.

import { basename, join } from "node:path";
import { logPath, ryuProfile } from "@ryuhq/core-client/data-dir";
import {
	ISSUE_REPOSITORY,
	problemChecks,
	redactDiagnosticText,
	type SimilarIssue,
	searchSimilarIssues,
	similarIssueQueries,
	statusMark,
	type TroubleshootReport,
	troubleshootCounts,
} from "@ryuhq/core-client/troubleshoot";
import { tf, tr, trMessage } from "../i18n/translate.ts";
import { localize } from "./localizedText.ts";
import { padCell } from "./migrate-render.ts";
import { GITHUB_TIMEOUT_MS } from "./troubleshoot-constants.ts";
import type { TroubleshootHost } from "./troubleshoot-host.ts";
import { machineLabel, machineValue } from "./troubleshoot-machine-text.ts";
import { gib, type TroubleshootOptions } from "./troubleshoot-probes.ts";
import type { CliContext } from "./types.ts";
import { VERSION } from "./version.ts";

export function machineInfo(
	host: TroubleshootHost,
	ctx: CliContext
): [string, string][] {
	const env = ctx.env;
	const rows: [string, string][] = [
		["OS", `${host.platform} ${host.osRelease} (${host.arch})`],
		["CPU", `${host.cpu.model ?? "unknown"} × ${host.cpu.count}`],
		[
			"Memory",
			localize("{total} total, {free} free", {
				free: gib(host.memory.freeBytes),
				total: gib(host.memory.totalBytes),
			}).english,
		],
		[
			"CLI",
			localize("ryu-cli {version} on {runtime}", {
				runtime: host.runtime,
				version: VERSION,
			}).english,
		],
		["Profile", ryuProfile(env)],
		["Core URL", redactDiagnosticText(ctx.target.url)],
		["Data dir", redactDiagnosticText(host.dataDir, { homeDir: host.homeDir })],
	];
	const shell = env.SHELL ?? env.ComSpec;
	if (shell) {
		rows.push(["Shell", basename(shell)]);
	}
	if (env.TERM_PROGRAM) {
		rows.push(["Terminal", env.TERM_PROGRAM]);
	}
	if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY) {
		rows.push([
			"Proxy",
			localize("{variables} is set", {
				variables: "HTTPS_PROXY/HTTP_PROXY",
			}).english,
		]);
	}
	return rows;
}

export async function findSimilarIssues(
	report: TroubleshootReport,
	host: TroubleshootHost,
	options: TroubleshootOptions
): Promise<{ error: string | null; issues: SimilarIssue[] }> {
	if (options.offline) {
		return { error: null, issues: [] };
	}
	const queries = similarIssueQueries(report);
	if (queries.length === 0) {
		return { error: null, issues: [] };
	}
	return await searchSimilarIssues(queries, {
		fetch: host.fetch,
		signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
	});
}

export async function saveReport(
	host: TroubleshootHost,
	content: string
): Promise<string | null> {
	const stamp = host.now().toISOString().replace(/[:.]/g, "-");
	const file = `troubleshoot-${stamp}.md`;
	for (const path of [logPath(host.dataDir, file), join(host.tempDir, file)]) {
		try {
			await host.writeFile(path, content);
			return path;
		} catch {
			// Fall through to the temp directory (unwritable or missing data dir).
		}
	}
	return null;
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface TroubleshootResult {
	fixes: string[];
	issueUrl: string;
	opened: boolean;
	report: TroubleshootReport;
	reportPath: string | null;
	similarIssuesError: string | null;
}

/**
 * A check's title in the CLI's language. The RAM check stays English: the
 * literal-only CLI translator would read its bare "Memory" title as Ryu's AI
 * memory feature (de "Gedächtnis", zh-CN 记忆).
 */
function checkTitle(check: { id: string; title: string }): string {
	return check.id === "memory" ? check.title : tr(check.title);
}

export function renderHuman(
	result: TroubleshootResult,
	host: TroubleshootHost
): string {
	const { report } = result;
	const shownPath = (path: string) =>
		redactDiagnosticText(path, { homeDir: host.homeDir });
	const lines = [
		tf("Ryu troubleshooter · ryu-cli {version}", { version: report.version }),
		"",
		tr("Machine"),
	];
	// Columns pad by terminal width, so CJK text keeps them aligned; --json and
	// the Markdown stay English.
	const translator = { tr, trMessage };
	const machine = report.machine.map(([label, value]) => [
		machineLabel(label, translator),
		machineValue(label, value, translator),
	]);
	const labelWidth = Math.max(
		...machine.map(([label = ""]) => Bun.stringWidth(label))
	);
	for (const [label = "", value] of machine) {
		lines.push(`  ${padCell(label, labelWidth)}  ${value}`);
	}
	if (result.fixes.length > 0) {
		lines.push("", tr("Fixes"));
		for (const fix of result.fixes) {
			lines.push(`  → ${fix}`);
		}
	}
	lines.push("", tr("Checks"));
	const titleWidth = Math.max(
		...report.checks.map((check) => Bun.stringWidth(checkTitle(check)))
	);
	for (const check of report.checks) {
		lines.push(
			`  ${statusMark(check.status)} ${padCell(checkTitle(check), titleWidth)}  ${trMessage(check.detail)}`
		);
		if (check.fix && (check.status === "fail" || check.status === "warn")) {
			const fix = trMessage(check.fix);
			lines.push(`    ${" ".repeat(titleWidth)}  ${tf("Fix: {fix}", { fix })}`);
		}
	}
	const counts = troubleshootCounts(report.checks);
	lines.push(
		"",
		tf(
			"{pass, plural, one {# passed} other {# passed}} · {warn, plural, one {# warning} other {# warnings}} · {fail, plural, one {# failed} other {# failed}} · {skip, plural, one {# skipped} other {# skipped}}",
			{
				fail: counts.fail,
				pass: counts.pass,
				skip: counts.skip,
				warn: counts.warn,
			}
		)
	);

	if (report.similarIssues.length > 0) {
		lines.push(
			"",
			tf("Similar issues on {repository}", { repository: ISSUE_REPOSITORY })
		);
		for (const issue of report.similarIssues) {
			lines.push(
				`  #${issue.number} [${issue.state}] ${issue.title}`,
				`    ${issue.url}`
			);
		}
		lines.push(
			`  ${tr("If one matches, add your report there (a 👍 or a comment) instead of opening a new issue.")}`
		);
	} else if (result.similarIssuesError) {
		lines.push(
			"",
			tf("Similar issues: {error}", { error: result.similarIssuesError })
		);
	}

	lines.push("");
	if (result.reportPath) {
		lines.push(
			tf("Full report saved to {path} (secrets and personal paths removed).", {
				path: shownPath(result.reportPath),
			})
		);
	}
	const problems = problemChecks(report.checks);
	lines.push(
		problems.length > 0
			? tr(
					"Still stuck after the fixes above? File a bug report. The form is prefilled; review it before you submit:"
				)
			: tr(
					"Every check passed. If something is still wrong, describe it and file a bug report:"
				),
		`  ${result.issueUrl}`
	);
	if (result.opened) {
		lines.push(`  ${tr("(Opened in your browser.)")}`);
	} else if (!report.description) {
		lines.push(
			`  ${tf('Tip: describe the problem to improve the search and the report: {command} troubleshoot "what went wrong"', { command: host.commandName })}`
		);
	}
	return `${lines.join("\n")}\n`;
}
