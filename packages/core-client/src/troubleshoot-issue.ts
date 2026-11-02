// The saved Markdown report and the prefilled GitHub new-issue URL. Nothing
// is posted: the user reviews every field in the browser. Every field is
// redacted again here so a caller that forgot to redact cannot leak it.
// Pure and browser-safe; re-exported from `./troubleshoot.ts`.

import {
	ISSUE_REPOSITORY,
	problemChecks,
	reportUnit,
	statusMark,
	type TroubleshootCheck,
	type TroubleshootReport,
	type TroubleshootUnit,
	troubleshootCounts,
} from "./troubleshoot-model.ts";
import { redactDiagnosticText } from "./troubleshoot-redaction.ts";

/** `mirror/overlay/.github/ISSUE_TEMPLATE/bug_report.yml`; field ids below. */
const ISSUE_TEMPLATE = "bug_report.yml";
/** GitHub and browsers reject very long URLs; stay well below ~8 KB. */
const MAX_ISSUE_URL_LENGTH = 7500;

// ── Report rendering ─────────────────────────────────────────────────────────

const DESCRIPTION_PLACEHOLDER =
	"<!-- Describe what you were doing, what you expected, and what happened instead. -->";

function isProblem(check: TroubleshootCheck): boolean {
	return check.status === "fail" || check.status === "warn";
}

/** A check as one Markdown bullet; the fix is shown only for a problem. */
function checkLine(check: TroubleshootCheck): string {
	const fix = check.fix && isProblem(check) ? `\n  - Fix: ${check.fix}` : "";
	return `- ${statusMark(check.status)} **${check.title}**: ${check.detail}${fix}`;
}

function machineLines(report: TroubleshootReport): string[] {
	return report.machine.map(([label, value]) => `${label}: ${value}`);
}

function countsLine(checks: readonly TroubleshootCheck[]): string {
	const counts = troubleshootCounts(checks);
	return `${counts.pass} passed · ${counts.warn} warnings · ${counts.fail} failed · ${counts.skip} skipped`;
}

/**
 * The full local report saved to disk: every check (including the passing
 * ones), machine info, similar issues and log excerpt. Redacted again here so a
 * caller that forgot to redact a field cannot leak it.
 */
export function renderTroubleshootMarkdown(
	report: TroubleshootReport,
	options: { homeDir?: string | null; issueUrl?: string } = {}
): string {
	const redact = (text: string) => redactDiagnosticText(text, options);
	const lines = [
		"# Ryu troubleshooting report",
		"",
		`Generated ${report.generatedAt} by ryu ${report.surface} ${report.version}.`,
		"",
		"## Problem",
		"",
		report.description ? redact(report.description) : "_Not described._",
		"",
		"## Machine",
		"",
		...machineLines(report).map((line) => `- ${redact(line)}`),
		"",
		"## Checks",
		"",
		countsLine(report.checks),
		"",
		...report.checks.map((check) => redact(checkLine(check))),
		"",
	];
	if (report.similarIssues.length > 0) {
		lines.push(
			"## Similar issues",
			"",
			...report.similarIssues.map(
				(issue) =>
					`- [#${issue.number}](${issue.url}) (${issue.state}) ${issue.title}`
			),
			""
		);
	}
	if (report.logExcerpt.length > 0) {
		lines.push(
			"## Recent log errors",
			"",
			"```text",
			...report.logExcerpt.map(redact),
			"```",
			""
		);
	}
	if (options.issueUrl) {
		lines.push(
			"## File a bug report",
			"",
			`[Open a prefilled issue on ${ISSUE_REPOSITORY}](${options.issueUrl})`,
			""
		);
	}
	return lines.join("\n");
}

// ── Prefilled issue ──────────────────────────────────────────────────────────

export function buildIssueTitle(
	report: TroubleshootReport,
	options: { homeDir?: string | null } = {}
): string {
	const summary = (
		redactDiagnosticText(report.description, options).split("\n")[0] ?? ""
	).trim();
	if (summary) {
		return clipCodePoints(summary, 90, 87);
	}
	const headline = problemChecks(report.checks)[0];
	// Redact before clipping: a cut through a token would leave a prefix too
	// short for its rule to recognise, and that prefix would reach the issue.
	return headline
		? clipCodePoints(
				redactDiagnosticText(`${headline.title}: ${headline.detail}`, options),
				90,
				90
			)
		: "Problem found with ryu troubleshoot";
}

/** Keep at most `max` code points (never splitting a surrogate pair), cutting
 *  to `keep` plus an ellipsis when it is shorter than the whole. */
function clipCodePoints(text: string, max: number, keep: number): string {
	const points = Array.from(text);
	if (points.length <= max) {
		return text;
	}
	const clipped = points.slice(0, keep).join("");
	return keep < max ? `${clipped}…` : clipped;
}

interface IssueFields {
	env: string;
	logs: string;
	repro: string;
	"what-happened": string;
}

function issueFields(
	report: TroubleshootReport,
	logLines: readonly string[],
	includePassing: boolean,
	redact: (text: string) => string
): IssueFields {
	const problems = problemChecks(report.checks);
	const shown = includePassing
		? report.checks.filter((check) => check.status !== "skip")
		: problems;
	const findings = shown.length
		? shown.map((check) => redact(checkLine(check))).join("\n")
		: "- All checks passed.";
	const related = report.similarIssues.length
		? `\n\nPossibly related: ${report.similarIssues.map((issue) => `#${issue.number}`).join(", ")}`
		: "";
	return {
		"what-happened": [
			report.description ? redact(report.description) : DESCRIPTION_PLACEHOLDER,
			"",
			`**\`ryu troubleshoot\` findings** (${countsLine(report.checks)}):`,
			"",
			findings,
		]
			.join("\n")
			.concat(related),
		repro: "1. \n2. \n3. ",
		env: [
			...machineLines(report).map(redact),
			`Reported by: ryu ${report.surface} ${report.version}`,
		].join("\n"),
		logs: logLines.map(redact).join("\n"),
	};
}

function issueUrlFor(
	title: string,
	unit: TroubleshootUnit,
	fields: IssueFields,
	repository: string
): string {
	const params = new URLSearchParams({
		template: ISSUE_TEMPLATE,
		title,
		unit,
		...fields,
	});
	return `https://github.com/${repository}/issues/new?${params.toString()}`;
}

/**
 * The GitHub new-issue URL with the bug template's fields prefilled. Nothing is
 * posted: the user reviews and submits in the browser. If the URL would be too
 * long, log lines and then passing checks are dropped first (the saved local
 * report keeps them all).
 */
export function buildIssueUrl(
	report: TroubleshootReport,
	options: {
		fallbackUnit: TroubleshootUnit;
		homeDir?: string | null;
		repository?: string;
	}
): string {
	const redact = (text: string) => redactDiagnosticText(text, options);
	const repository = options.repository ?? ISSUE_REPOSITORY;
	const title = redact(buildIssueTitle(report, options));
	const unit = reportUnit(report, options.fallbackUnit);
	let logLines = report.logExcerpt.slice(-20);
	let includePassing = true;
	for (;;) {
		const url = issueUrlFor(
			title,
			unit,
			issueFields(report, logLines, includePassing, redact),
			repository
		);
		if (url.length <= MAX_ISSUE_URL_LENGTH) {
			return url;
		}
		if (logLines.length > 0) {
			// Keep the newest half; the last lines are usually the decisive ones.
			logLines = logLines.slice(Math.ceil(logLines.length / 2));
		} else if (includePassing) {
			includePassing = false;
		} else {
			return truncatedIssueUrl(report, title, unit, repository, redact);
		}
	}
}

/** Last resort for a very long description: shorten the free-text field
 *  explicitly (and say so) rather than let GitHub or the browser cut the URL. */
function truncatedIssueUrl(
	report: TroubleshootReport,
	title: string,
	unit: TroubleshootUnit,
	repository: string,
	redact: (text: string) => string
): string {
	const fields = issueFields(report, [], false, redact);
	let text = fields["what-happened"];
	let url = issueUrlFor(title, unit, fields, repository);
	while (url.length > MAX_ISSUE_URL_LENGTH && text.length > 200) {
		text = text.slice(0, Math.floor(text.length * 0.75));
		url = issueUrlFor(
			title,
			unit,
			{
				...fields,
				"what-happened": `${text}…\n\n_(Truncated. Attach the saved local report from \`ryu troubleshoot\`.)_`,
			},
			repository
		);
	}
	return url;
}
