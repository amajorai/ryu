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
import { GITHUB_TIMEOUT_MS } from "./troubleshoot-constants.ts";
import type { TroubleshootHost } from "./troubleshoot-host.ts";
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
			`${gib(host.memory.totalBytes)} total, ${gib(host.memory.freeBytes)} free`,
		],
		["CLI", `ryu-cli ${VERSION} on ${host.runtime}`],
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
		rows.push(["Proxy", "HTTPS_PROXY/HTTP_PROXY is set"]);
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

export function renderHuman(
	result: TroubleshootResult,
	host: TroubleshootHost
): string {
	const { report } = result;
	const shownPath = (path: string) =>
		redactDiagnosticText(path, { homeDir: host.homeDir });
	const lines = [
		`Ryu troubleshooter · ryu-cli ${report.version}`,
		"",
		"Machine",
	];
	const labelWidth = Math.max(...report.machine.map(([label]) => label.length));
	for (const [label, value] of report.machine) {
		lines.push(`  ${label.padEnd(labelWidth)}  ${value}`);
	}
	if (result.fixes.length > 0) {
		lines.push("", "Fixes");
		for (const fix of result.fixes) {
			lines.push(`  → ${fix}`);
		}
	}
	lines.push("", "Checks");
	const titleWidth = Math.max(
		...report.checks.map((check) => check.title.length)
	);
	for (const check of report.checks) {
		lines.push(
			`  ${statusMark(check.status)} ${check.title.padEnd(titleWidth)}  ${check.detail}`
		);
		if (check.fix && (check.status === "fail" || check.status === "warn")) {
			lines.push(`    ${" ".repeat(titleWidth)}  Fix: ${check.fix}`);
		}
	}
	const counts = troubleshootCounts(report.checks);
	lines.push(
		"",
		`${counts.pass} passed · ${counts.warn} warnings · ${counts.fail} failed · ${counts.skip} skipped`
	);

	if (report.similarIssues.length > 0) {
		lines.push("", `Similar issues on ${ISSUE_REPOSITORY}`);
		for (const issue of report.similarIssues) {
			lines.push(
				`  #${issue.number} [${issue.state}] ${issue.title}`,
				`    ${issue.url}`
			);
		}
		lines.push(
			"  If one matches, add your report there (a 👍 or a comment) instead of opening a new issue."
		);
	} else if (result.similarIssuesError) {
		lines.push("", `Similar issues: ${result.similarIssuesError}`);
	}

	lines.push("");
	if (result.reportPath) {
		lines.push(
			`Full report saved to ${shownPath(result.reportPath)} (secrets and personal paths removed).`
		);
	}
	const problems = problemChecks(report.checks);
	lines.push(
		problems.length > 0
			? "Still stuck after the fixes above? File a bug report. The form is prefilled; review it before you submit:"
			: "Every check passed. If something is still wrong, describe it and file a bug report:",
		`  ${result.issueUrl}`
	);
	if (result.opened) {
		lines.push("  (Opened in your browser.)");
	} else if (!report.description) {
		lines.push(
			`  Tip: describe the problem to improve the search and the report: ${host.commandName} troubleshoot "what went wrong"`
		);
	}
	return `${lines.join("\n")}\n`;
}
