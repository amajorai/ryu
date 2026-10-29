// Shared, surface-agnostic half of the Ryu troubleshooter: the check/report
// model, secret and PII redaction, the similar-issue search against the public
// tracker, the saved Markdown report, and the prefilled bug-report URL.
//
// Pure and browser-safe (no node:* imports, `fetch` injected) so the CLI's
// `ryu troubleshoot` and any graphical surface produce the SAME report and the
// SAME issue shape. The probes themselves (filesystem, ports, binaries) are
// surface-specific and live with each surface.
//
// Privacy contract: nothing here sends a report anywhere. `buildIssueUrl` only
// prefills GitHub's new-issue form, so the user reviews every field in the
// browser before anything is posted. The one outbound call, the similar-issue
// search, sends search keywords only, never the report.

import { z } from "zod";

/** The public tracker for the open-source units (Core, Gateway, CLI, SDK, docs). */
export const ISSUE_REPOSITORY = "amajorai/ryu";
/** `mirror/overlay/.github/ISSUE_TEMPLATE/bug_report.yml`; field ids below. */
const ISSUE_TEMPLATE = "bug_report.yml";
/** GitHub and browsers reject very long URLs; stay well below ~8 KB. */
const MAX_ISSUE_URL_LENGTH = 7500;
const MAX_SIMILAR_ISSUES = 5;
const MAX_DESCRIPTION_KEYWORDS = 6;
const GITHUB_API = "https://api.github.com";

export type TroubleshootStatus = "pass" | "info" | "warn" | "fail" | "skip";

/** The `unit` field of the bug template: which open-source unit is at fault. */
export type TroubleshootUnit =
	| "apps/core"
	| "apps/gateway"
	| "apps/cli"
	| "packages/sdk"
	| "docs";

export interface TroubleshootCheck {
	/** One line: what was found. Already free of secrets (see redaction). */
	detail: string;
	/** What the user can do about it: a command or a short instruction. Shown
	 *  only while the check is a problem (`fail`/`warn`). */
	fix?: string;
	/** Stable id (`core.reachable`), used for search terms and tests. */
	id: string;
	/** Phrase searched for in the tracker when this check is a problem. */
	searchTerms?: string;
	status: TroubleshootStatus;
	title: string;
	/** The unit to file against when this check is the headline problem.
	 *  `fix`, `searchTerms` and `unit` may be set on a passing check; every
	 *  consumer reads them only for problems. */
	unit?: TroubleshootUnit;
}

export interface SimilarIssue {
	number: number;
	state: "open" | "closed";
	title: string;
	updatedAt: string;
	url: string;
}

export interface TroubleshootReport {
	checks: TroubleshootCheck[];
	/** The user's own words about the problem; empty when not given. */
	description: string;
	generatedAt: string;
	/** Recent error lines from local logs, already redacted. */
	logExcerpt: string[];
	/** Ordered label/value pairs (OS, arch, memory, versions, …). */
	machine: [label: string, value: string][];
	similarIssues: SimilarIssue[];
	/** Which surface produced the report (`cli`, `desktop`). */
	surface: string;
	/** The reporting surface's version. */
	version: string;
}

// ── Redaction ────────────────────────────────────────────────────────────────

const SECRET_KEY_NAMES =
	"api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|authorization";

/** Ordered rewrites. Each is idempotent: running redaction twice is a no-op. */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		"[REDACTED PRIVATE KEY]",
	],
	[
		/\b(Bearer|Basic)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi,
		"$1 [REDACTED]",
	],
	// `Authorization: Token <value>` (only in a header: "token" is also prose).
	[
		/(\bAuthorization["']?\s*[:=]\s*["']?Token)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi,
		"$1 [REDACTED]",
	],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED TOKEN]"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED TOKEN]"],
	[/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED KEY]"],
	[/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED TOKEN]"],
	[/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED KEY]"],
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED KEY]"],
	[/\bhf_[A-Za-z0-9]{20,}\b/g, "[REDACTED TOKEN]"],
	[
		/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
		"[REDACTED JWT]",
	],
	// scheme://user:password@host → scheme://[REDACTED]@host
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
	// ?token=…&key=… query parameters.
	[
		/([?&](?:token|key|api_key|access_token|secret|sig|signature|code)=)[^&\s#]+/gi,
		"$1[REDACTED]",
	],
	// key=value, key: value, "key": "value", including prefixed environment
	// names such as RYU_CORE_TOKEN or OPENAI_API_KEY.
	[
		new RegExp(
			`(["']?\\b(?:[A-Za-z0-9]+[_-])*(?:${SECRET_KEY_NAMES})\\b["']?\\s*[=:]\\s*["']?)(?!\\[REDACTED)[^\\s"',;}&]+`,
			"gi"
		),
		"$1[REDACTED]",
	],
	// Starts only at the beginning of a run, so a long run with no `@` (a
	// pasted blob) is scanned once instead of once per character.
	[
		/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
		"[REDACTED EMAIL]",
	],
	// User home directories on every OS → `~`.
	[/\/(?:Users|home)\/[^/\s"'`]+/g, "~"],
	[/\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "~"],
];

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/** Loopback, private, link-local and unspecified addresses carry no identity
 *  and are often the whole point of a diagnostic (`127.0.0.1:7980`). */
function isNonIdentifyingIpv4(octets: number[]): boolean {
	const [a = 0, b = 0] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

/**
 * Strip credentials, emails, home paths and public IP addresses from free text
 * before it is shown, saved or put into an issue. `homeDir` additionally
 * rewrites that exact path (covers relocated homes the generic rules miss).
 */
export function redactDiagnosticText(
	text: string,
	options: { homeDir?: string | null } = {}
): string {
	let out = text;
	const home = options.homeDir?.trim();
	if (home && home.length > 1) {
		out = out.split(home).join("~");
	}
	for (const [pattern, replacement] of REDACTIONS) {
		out = out.replace(pattern, replacement);
	}
	return out.replace(IPV4, (match, ...groups: string[]) => {
		const octets = groups.slice(0, 4).map(Number);
		if (octets.some((octet) => octet > 255)) {
			return match;
		}
		return isNonIdentifyingIpv4(octets) ? match : "[REDACTED IP]";
	});
}

// ── Summaries ────────────────────────────────────────────────────────────────

export type TroubleshootCounts = Record<TroubleshootStatus, number>;

export function troubleshootCounts(
	checks: readonly TroubleshootCheck[]
): TroubleshootCounts {
	const counts: TroubleshootCounts = {
		fail: 0,
		info: 0,
		pass: 0,
		skip: 0,
		warn: 0,
	};
	for (const check of checks) {
		counts[check.status] += 1;
	}
	return counts;
}

/** Failures first, then warnings, in check order. */
export function problemChecks(
	checks: readonly TroubleshootCheck[]
): TroubleshootCheck[] {
	return [
		...checks.filter((check) => check.status === "fail"),
		...checks.filter((check) => check.status === "warn"),
	];
}

const STATUS_MARK: Record<TroubleshootStatus, string> = {
	fail: "✗",
	info: "•",
	pass: "✓",
	skip: "-",
	warn: "!",
};

export function statusMark(status: TroubleshootStatus): string {
	return STATUS_MARK[status];
}

// ── Similar-issue search ─────────────────────────────────────────────────────

const STOP_WORDS = new Set(
	"a about after again all also an and any are as at be because been before being but by can cannot could did does doing dont for from get gets getting had has have how i im in into is it its just keeps me my no not of on or out please really ryu so some still that the their them then there this to tried trying up use using was we were what when where which while why will with without work works working would you".split(
		" "
	)
);

/** The few distinctive words of a free-text description, in order. */
export function descriptionKeywords(
	text: string,
	max = MAX_DESCRIPTION_KEYWORDS
): string[] {
	const seen = new Set<string>();
	const words: string[] = [];
	for (const raw of text.toLowerCase().split(/[^a-z0-9._-]+/)) {
		const word = raw.replace(/^[._-]+|[._-]+$/g, "");
		if (word.length < 3 || STOP_WORDS.has(word) || seen.has(word)) {
			continue;
		}
		seen.add(word);
		words.push(word);
		if (words.length >= max) {
			break;
		}
	}
	return words;
}

/**
 * At most two search phrases: the user's own words (most specific), then the
 * headline problem check. GitHub ANDs terms, so one long query would match
 * nothing; two short ones find the likely duplicates.
 */
export function similarIssueQueries(report: TroubleshootReport): string[] {
	const queries: string[] = [];
	const keywords = descriptionKeywords(
		redactDiagnosticText(report.description)
	).filter((word) => !word.startsWith("[redacted"));
	if (keywords.length > 0) {
		queries.push(keywords.join(" "));
	}
	const headline = problemChecks(report.checks).find(
		(check) => check.searchTerms
	);
	if (headline?.searchTerms && !queries.includes(headline.searchTerms)) {
		queries.push(headline.searchTerms);
	}
	return queries;
}

const githubIssueSearchSchema = z.object({
	items: z
		.array(
			z.object({
				html_url: z.string(),
				number: z.number(),
				pull_request: z.unknown().optional(),
				state: z.string(),
				title: z.string(),
				updated_at: z.string(),
			})
		)
		.catch(() => []),
});

export interface SimilarIssueSearchResult {
	/** Set when the search could not run (offline, rate limited, …). */
	error: string | null;
	issues: SimilarIssue[];
}

/**
 * Search the public tracker for issues matching `queries` (see
 * {@link similarIssueQueries}). Never throws: an unreachable or rate-limited
 * GitHub becomes `error`, so the troubleshooter still produces its report.
 */
export async function searchSimilarIssues(
	queries: readonly string[],
	options: {
		fetch: typeof fetch;
		limit?: number;
		repository?: string;
		signal?: AbortSignal;
	}
): Promise<SimilarIssueSearchResult> {
	const limit = options.limit ?? MAX_SIMILAR_ISSUES;
	const repository = options.repository ?? ISSUE_REPOSITORY;
	const byNumber = new Map<number, SimilarIssue>();
	let error: string | null = null;
	for (const query of queries) {
		if (byNumber.size >= limit) {
			break;
		}
		const q = `repo:${repository} is:issue ${query}`;
		const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}`;
		try {
			const response = await options.fetch(url, {
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: options.signal,
			});
			if (!response.ok) {
				error =
					response.status === 403 || response.status === 429
						? "GitHub search rate limit reached; try again in a minute."
						: `GitHub search failed (HTTP ${response.status}).`;
				continue;
			}
			const parsed = githubIssueSearchSchema.safeParse(await response.json());
			if (!parsed.success) {
				error = "GitHub search returned an unexpected response.";
				continue;
			}
			for (const item of parsed.data.items) {
				if (item.pull_request !== undefined || byNumber.has(item.number)) {
					continue;
				}
				byNumber.set(item.number, {
					number: item.number,
					state: item.state === "closed" ? "closed" : "open",
					title: item.title,
					updatedAt: item.updated_at,
					url: item.html_url,
				});
			}
		} catch (cause) {
			error = `GitHub search unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}
	const issues = [...byNumber.values()].slice(0, limit);
	// A partial failure that still found matches is not worth surfacing.
	return { error: issues.length > 0 ? null : error, issues };
}

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

/** The unit of the headline problem, else the reporting surface's own unit. */
export function reportUnit(
	report: TroubleshootReport,
	fallback: TroubleshootUnit
): TroubleshootUnit {
	return (
		problemChecks(report.checks).find((check) => check.unit)?.unit ?? fallback
	);
}

export function buildIssueTitle(report: TroubleshootReport): string {
	const summary = (
		redactDiagnosticText(report.description).split("\n")[0] ?? ""
	).trim();
	if (summary) {
		return summary.length > 90 ? `${summary.slice(0, 87)}…` : summary;
	}
	const headline = problemChecks(report.checks)[0];
	return headline
		? `${headline.title}: ${headline.detail}`.slice(0, 90)
		: "Problem found with ryu troubleshoot";
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
	const title = redact(buildIssueTitle(report));
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
