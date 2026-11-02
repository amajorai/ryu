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
//
// This module is the stable import path (`@ryuhq/core-client/troubleshoot`);
// each responsibility lives in its own `troubleshoot-*.ts` file.

export {
	buildIssueTitle,
	buildIssueUrl,
	renderTroubleshootMarkdown,
} from "./troubleshoot-issue.ts";
export {
	ISSUE_REPOSITORY,
	problemChecks,
	reportUnit,
	type SimilarIssue,
	statusMark,
	type TroubleshootCheck,
	type TroubleshootCounts,
	type TroubleshootReport,
	type TroubleshootStatus,
	type TroubleshootUnit,
	troubleshootCounts,
} from "./troubleshoot-model.ts";
export { redactDiagnosticText } from "./troubleshoot-redaction.ts";
export {
	descriptionKeywords,
	type SimilarIssueSearchResult,
	searchSimilarIssues,
	similarIssueQueries,
} from "./troubleshoot-search.ts";
