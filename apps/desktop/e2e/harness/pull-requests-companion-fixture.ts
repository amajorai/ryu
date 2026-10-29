interface ProofActor {
	avatarUrl?: string;
	login?: string;
	name?: string;
}

interface ProofLabel {
	color: string;
	name: string;
}

interface ProofRepository {
	nameWithOwner: string;
}

interface ProofPullSummary {
	_scope: "all" | "authored" | "reviewing";
	author: ProofActor;
	commentsCount: number;
	createdAt: string;
	isDraft: boolean;
	labels: ProofLabel[];
	mergedAt: string | null;
	number: number;
	repository: ProofRepository;
	state: "OPEN" | "CLOSED" | "MERGED";
	title: string;
	updatedAt: string;
	url: string;
}

interface ProofPullDetail extends ProofPullSummary {
	additions: number;
	assignees: ProofActor[];
	baseRefName: string;
	body: string;
	changedFiles: number;
	closingIssuesReferences: Array<{
		number: number;
		repository: ProofRepository;
		state: string;
		title: string;
		url: string;
	}>;
	comments: Array<{
		author: ProofActor;
		body: string;
		createdAt: string;
		url: string;
	}>;
	deletions: number;
	diffPatch: string;
	files: Array<{ additions: number; deletions: number; path: string }>;
	headRefName: string;
	latestReviews: Array<{
		author: ProofActor;
		body: string;
		state: string;
		submittedAt: string;
	}>;
	mergeable: string;
	mergeStateStatus: string;
	reviewDecision: string;
	reviewRequests: Array<{ requestedReviewer: ProofActor }>;
	statusCheckRollup: Array<{
		bucket: string;
		conclusion: string;
		name: string;
	}>;
}

interface ProofIssueSummary {
	_scope: "all" | "assigned" | "authored";
	author: ProofActor;
	closedAt: string | null;
	commentsCount: number;
	createdAt: string;
	labels: ProofLabel[];
	number: number;
	repository: ProofRepository;
	state: "OPEN" | "CLOSED";
	title: string;
	updatedAt: string;
	url: string;
}

interface ProofIssueDetail extends ProofIssueSummary {
	assignees: ProofActor[];
	body: string;
	comments: Array<{
		author: ProofActor;
		body: string;
		createdAt: string;
		url: string;
	}>;
}

export interface PullRequestsProofState {
	authComplete: boolean;
	authenticated: boolean;
	commands: Array<{ argv: string[]; cwd: string | null; failed: boolean }>;
	failNext: Array<{ match: string; message: string }>;
	issueDetails: Record<string, ProofIssueDetail>;
	issues: ProofIssueSummary[];
	mergeStatuses: Record<
		string,
		{ details?: { message?: string }; pullNumbers?: number[]; status: string }
	>;
	nextStackNumber: number;
	pullDetails: Record<string, ProofPullDetail>;
	pulls: ProofPullSummary[];
	stacks: Record<string, { pullRequests: number[]; repository: string }>;
}

const repository = "octo/ryu";
const repositoryValue = { nameWithOwner: repository };
const timestamp = "2026-09-26T12:00:00Z";
const proofAuthor = { login: "proof-reviewer", name: "Proof Reviewer" };
const teammate = { login: "octo-contributor", name: "Octo Contributor" };
const reviewer = { login: "proof-reviewer", name: "Proof Reviewer" };

function pull(
	number: number,
	title: string,
	state: ProofPullSummary["state"],
	scope: ProofPullSummary["_scope"],
	options: { draft?: boolean; comments?: number } = {}
): ProofPullSummary {
	return {
		_scope: scope,
		author: scope === "authored" ? proofAuthor : teammate,
		commentsCount: options.comments ?? 1,
		createdAt: timestamp,
		isDraft: options.draft ?? false,
		labels: [{ color: "1f6feb", name: "ready-for-review" }],
		mergedAt: state === "MERGED" ? timestamp : null,
		number,
		repository: repositoryValue,
		state,
		title,
		updatedAt: timestamp,
		url: `https://github.com/${repository}/pull/${number}`,
	};
}

function issue(
	number: number,
	title: string,
	state: ProofIssueSummary["state"],
	scope: ProofIssueSummary["_scope"]
): ProofIssueSummary {
	return {
		_scope: scope,
		author: scope === "authored" ? proofAuthor : teammate,
		closedAt: state === "CLOSED" ? timestamp : null,
		commentsCount: 1,
		createdAt: timestamp,
		labels: [{ color: "d73a4a", name: "bug" }],
		number,
		repository: repositoryValue,
		state,
		title,
		updatedAt: timestamp,
		url: `https://github.com/${repository}/issues/${number}`,
	};
}

// Each non-billing PR gets its own patch so a proof can tell which PR's diff
// reached the Changes tab or the assistant context.
function changePatch(number: number): string {
	return [
		`diff --git a/src/change-${number}.ts b/src/change-${number}.ts`,
		"index 3333333..4444444 100644",
		`--- a/src/change-${number}.ts`,
		`+++ b/src/change-${number}.ts`,
		"@@ -1,1 +1,1 @@",
		`-export const change${number} = false;`,
		`+export const change${number} = true;`,
	].join("\n");
}

export function createPullRequestsProofState(
	authenticated = true
): PullRequestsProofState {
	const pullSummaries = [
		pull(
			101,
			"Protect billing retries from duplicate charges",
			"OPEN",
			"reviewing"
		),
		pull(102, "Rotate session cookie after sign-in", "OPEN", "authored", {
			draft: true,
		}),
		pull(103, "Expose usage export endpoint", "OPEN", "reviewing", {
			comments: 4,
		}),
		pull(104, "Document merged token refresh behavior", "MERGED", "authored"),
		pull(105, "Remove deprecated callback route", "CLOSED", "all"),
		pull(106, "Keep retry metadata in audit events", "OPEN", "reviewing"),
	];
	const firstPull: ProofPullDetail = {
		...pullSummaries[0]!,
		additions: 24,
		assignees: [teammate],
		baseRefName: "main",
		body: [
			"## What changed",
			"Retries now reuse the original idempotency key.",
			"",
			"## Checklist",
			"- [x] Persist the idempotency key https://github.com/octo/ryu/issues/701",
			"- [ ] Add a regression test for duplicate requests",
			"",
			"```md",
			"- [ ] This fenced example is not a live task",
			"```",
		].join("\n"),
		changedFiles: 2,
		closingIssuesReferences: [
			{
				number: 701,
				repository: repositoryValue,
				state: "OPEN",
				title: "Duplicate checkout jobs charge twice",
				url: `https://github.com/${repository}/issues/701`,
			},
		],
		comments: [
			{
				author: teammate,
				body: "The retry test covers the original request id.",
				createdAt: timestamp,
				url: `https://github.com/${repository}/pull/101#issuecomment-1`,
			},
		],
		deletions: 3,
		diffPatch: [
			"diff --git a/src/billing.ts b/src/billing.ts",
			"index 1111111..2222222 100644",
			"--- a/src/billing.ts",
			"+++ b/src/billing.ts",
			"@@ -12,1 +12,3 @@ export async function charge(order) {",
			"+  const requestKey = idempotencyKey(order);",
			"+  return chargeOnce(order, requestKey);",
		].join("\n"),
		files: [
			{ additions: 20, deletions: 3, path: "src/billing.ts" },
			{ additions: 4, deletions: 0, path: "tests/billing.test.ts" },
		],
		headRefName: "fix/billing-idempotency",
		latestReviews: [
			{
				author: reviewer,
				body: "Please keep the retry key stable across attempts.",
				state: "COMMENTED",
				submittedAt: timestamp,
			},
		],
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		reviewDecision: "REVIEW_REQUIRED",
		reviewRequests: [{ requestedReviewer: reviewer }],
		statusCheckRollup: [
			{
				bucket: "pass",
				conclusion: "SUCCESS",
				name: "unit-tests",
			},
			{
				bucket: "fail",
				conclusion: "FAILURE",
				name: "typecheck",
			},
		],
	};
	const issueSummaries = [
		issue(701, "Duplicate checkout jobs charge twice", "OPEN", "assigned"),
		issue(702, "Add an audit event for key rotation", "OPEN", "authored"),
		issue(703, "Document the retired callback route", "CLOSED", "assigned"),
	];
	const firstIssue: ProofIssueDetail = {
		...issueSummaries[0]!,
		assignees: [proofAuthor],
		body: "Two retries with the same order can charge twice. Keep one idempotency key for the complete retry window.",
		comments: [
			{
				author: teammate,
				body: "I can reproduce this with the timeout path.",
				createdAt: timestamp,
				url: `https://github.com/${repository}/issues/701#issuecomment-1`,
			},
		],
	};
	const pullDetails = Object.fromEntries(
		pullSummaries.map((summary): [string, ProofPullDetail] => [
			`${repository}#${summary.number}`,
			{
				...summary,
				additions: summary.number === 101 ? 24 : 8,
				assignees: [],
				baseRefName: "main",
				body:
					summary.number === 101
						? firstPull.body
						: `Details for PR #${summary.number}.`,
				changedFiles: summary.number === 101 ? 2 : 1,
				closingIssuesReferences: [],
				comments: [],
				deletions: 1,
				diffPatch: changePatch(summary.number),
				files: [
					{
						additions: 8,
						deletions: 1,
						path: `src/change-${summary.number}.ts`,
					},
				],
				headRefName:
					summary.number === 101
						? "fix/billing-idempotency"
						: `feature/pr-${summary.number}`,
				latestReviews: [],
				mergeable: "MERGEABLE",
				mergeStateStatus: "CLEAN",
				reviewDecision: "REVIEW_REQUIRED",
				reviewRequests: [],
				statusCheckRollup: [],
			},
		])
	);
	pullDetails[`${repository}#101`] = firstPull;
	const issueDetails = Object.fromEntries(
		issueSummaries.map((summary): [string, ProofIssueDetail] => [
			`${repository}#${summary.number}`,
			{
				...summary,
				assignees: summary.number === 701 ? [proofAuthor] : [],
				body:
					summary.number === 701
						? firstIssue.body
						: `Issue description for #${summary.number}.`,
				comments: [],
			},
		])
	);
	issueDetails[`${repository}#701`] = firstIssue;
	return {
		authenticated,
		authComplete: false,
		commands: [],
		failNext: [],
		issues: issueSummaries,
		issueDetails,
		mergeStatuses: {},
		nextStackNumber: 900,
		pullDetails,
		pulls: pullSummaries,
		stacks: {},
	};
}
