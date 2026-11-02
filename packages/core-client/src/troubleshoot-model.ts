// The troubleshooter's report model and its summaries: check statuses, the
// report shape every surface fills in, counts, and the headline problem.
// Pure and browser-safe; re-exported from `./troubleshoot.ts`.

/** The public tracker for the open-source units (Core, Gateway, CLI, SDK, docs). */
export const ISSUE_REPOSITORY = "amajorai/ryu";

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

/** The unit of the headline problem, else the reporting surface's own unit. */
export function reportUnit(
	report: TroubleshootReport,
	fallback: TroubleshootUnit
): TroubleshootUnit {
	return (
		problemChecks(report.checks).find((check) => check.unit)?.unit ?? fallback
	);
}
