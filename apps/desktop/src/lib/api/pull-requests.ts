import { ownAppRequest } from "./app-request.ts";
import type { ApiTarget } from "./client.ts";
import {
	gitHubRepositoryResponseSchema,
	gitHubRepositoryWireSchema,
	gitPullRequestWireSchema,
	pullRequestFeedbackSchema,
	pullRequestResponseSchema,
} from "./pull-request-wire-contracts.ts";

export const PULL_REQUESTS_APP_ID = "@ryu/pull-requests";
export type GitPullRequestLookupState = "all" | "open";

export interface GitHubRepository {
	defaultBranch: string | null;
	nameWithOwner: string;
	url: string;
}

export type GitHubRepositoryVisibility = "private" | "public";

export interface PullRequestCheck {
	bucket: string | null;
	conclusion: string | null;
	description: string | null;
	detailsUrl: string | null;
	name: string | null;
	state: string | null;
	status: string | null;
	workflowName: string | null;
}

export interface GitPullRequest {
	baseRefName: string | null;
	branch: string | null;
	commentsCount: number | null;
	headRefName: string | null;
	headRefOid: string | null;
	isDraft: boolean;
	mergeable: string | null;
	mergedAt: string | null;
	mergeStateStatus: string | null;
	number: number;
	repository: string | null;
	state: string | null;
	statusCheckRollup: PullRequestCheck[];
	title: string;
	updatedAt: string | null;
	url: string;
}

export type GitPullRequestStatus = "closed" | "draft" | "merged" | "open";

/** One conversation comment, review, or open inline review comment left on a
 * pull request. */
export interface PullRequestFeedback {
	author: string | null;
	/** GitHub's author association, upper-cased (`OWNER`, `MEMBER`,
	 * `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, …). */
	authorAssociation: string | null;
	/** A GitHub App or other bot account. */
	authorIsBot: boolean;
	body: string;
	createdAt: string | null;
	id: string;
	/** Hidden on GitHub as spam, off-topic, outdated, or similar. */
	isMinimized: boolean;
	kind: "comment" | "review" | "review_comment";
	/** File line of an inline review comment. */
	line: number | null;
	/** File path of an inline review comment. */
	path: string | null;
	/** Review state (`CHANGES_REQUESTED`, `COMMENTED`, …); null for comments. */
	state: string | null;
	url: string | null;
	/** Written by the GitHub account the node's `gh` CLI is signed in as. */
	viewerDidAuthor: boolean;
}

export interface PullRequestReference {
	number: number;
	owner: string;
	repo: string;
	/** Canonical `https://github.com/<owner>/<repo>/pull/<n>` form. */
	url: string;
}

const GITHUB_PREFIX = "https://github.com/";
const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const PULL_NUMBER_RE = /^\+?\d+$/;

const isGitHubName = (segment: string | undefined): segment is string =>
	segment !== undefined &&
	GITHUB_NAME_RE.test(segment) &&
	segment !== "." &&
	segment !== "..";

/** Parse a GitHub pull request link into its canonical form. Mirrors Core's
 * `normalize_pull_request_url` step for step (split on `/`, `?`, `#`; owner,
 * repo, `pull`/`pulls`, then a positive number), so a link the desktop accepts
 * is one Core stores. The one deliberate difference: numbers above
 * `Number.MAX_SAFE_INTEGER` are rejected here, where Core allows any `u64`. */
export function parsePullRequestUrl(raw: string): PullRequestReference | null {
	const trimmed = raw.trim();
	if (!trimmed.startsWith(GITHUB_PREFIX)) {
		return null;
	}
	const [owner, repo, kind, digits] = trimmed
		.slice(GITHUB_PREFIX.length)
		.split(/[/?#]/);
	if (
		!(
			isGitHubName(owner) &&
			isGitHubName(repo) &&
			(kind === "pull" || kind === "pulls") &&
			digits &&
			PULL_NUMBER_RE.test(digits)
		)
	) {
		return null;
	}
	const number = Number(digits);
	if (!Number.isSafeInteger(number) || number <= 0) {
		return null;
	}
	return {
		number,
		owner,
		repo,
		url: `${GITHUB_PREFIX}${owner}/${repo}/pull/${number}`,
	};
}

export function gitPullRequestStatus(
	pullRequest: Pick<GitPullRequest, "isDraft" | "mergedAt" | "state">
): GitPullRequestStatus {
	const state = pullRequest.state?.toLowerCase();
	if (pullRequest.mergedAt || state === "merged") {
		return "merged";
	}
	if (pullRequest.isDraft) {
		return "draft";
	}
	if (state === "closed") {
		return "closed";
	}
	return "open";
}

export function gitPullRequestStatusLabel(
	status: GitPullRequestStatus
): string {
	return `${status[0]?.toUpperCase() ?? ""}${status.slice(1)} pull request`;
}

const MAX_REPORT_CHARS = 12_000;

export function normalizeGitHubRepository(
	value: Parameters<typeof gitHubRepositoryWireSchema.parse>[0]
): GitHubRepository | null {
	return gitHubRepositoryWireSchema.parse(value);
}

/** Normalize the app and Core creation responses into the desktop contract. */
export function normalizeGitPullRequest(
	value: Parameters<typeof gitPullRequestWireSchema.parse>[0]
): GitPullRequest | null {
	return gitPullRequestWireSchema.parse(value);
}

/** GitHub reports merge conflicts as `CONFLICTING`/`DIRTY`; other blocked or
 * pending merge states are not conflicts and should not offer the conflict Fix
 * action. */
export function pullRequestHasMergeConflicts(
	pullRequest: Pick<GitPullRequest, "mergeStateStatus" | "mergeable">
): boolean {
	return [pullRequest.mergeable, pullRequest.mergeStateStatus].some((value) => {
		const normalized = value?.trim().toLowerCase();
		return normalized === "conflicting" || normalized === "dirty";
	});
}

export function checkBucket(
	check: PullRequestCheck
): "cancel" | "fail" | "pass" | "pending" | "skipping" {
	const bucket = check.bucket?.toLowerCase();
	if (bucket === "pass" || bucket === "success") {
		return "pass";
	}
	if (bucket === "fail" || bucket === "failure" || bucket === "error") {
		return "fail";
	}
	if (bucket === "cancel" || bucket === "cancelled") {
		return "cancel";
	}
	if (bucket === "skipping" || bucket === "skipped") {
		return "skipping";
	}
	const state = `${check.state ?? ""} ${check.status ?? ""}`.toLowerCase();
	if (state.includes("success") || state.includes("completed")) {
		return "pass";
	}
	if (state.includes("failure") || state.includes("error")) {
		return "fail";
	}
	return "pending";
}

export function failingPullRequestChecks(
	pullRequest: GitPullRequest
): PullRequestCheck[] {
	return pullRequest.statusCheckRollup.filter(
		(check) => checkBucket(check) === "fail"
	);
}

function reportLine(label: string, value: string | null): string {
	return `${label}: ${value ?? "unknown"}`;
}

/** Build a bounded, metadata-only report for the user-triggered Fix action. */
export function buildPullRequestCheckReport(
	pullRequest: GitPullRequest
): string {
	const failing = failingPullRequestChecks(pullRequest);
	const lines = [
		"Ryu CI failure report",
		"",
		reportLine("Pull request", `#${pullRequest.number} ${pullRequest.title}`),
		reportLine("URL", pullRequest.url),
		reportLine(
			"Comments",
			pullRequest.commentsCount === null
				? null
				: String(pullRequest.commentsCount)
		),
		reportLine("Repository", pullRequest.repository),
		reportLine("Branch", pullRequest.headRefName ?? pullRequest.branch),
		reportLine("Base", pullRequest.baseRefName),
		reportLine("Head SHA", pullRequest.headRefOid),
		`Failing checks: ${failing.length}`,
		"",
	];
	for (const [index, check] of failing.entries()) {
		lines.push(
			`${index + 1}. ${check.name ?? "Unnamed check"}`,
			`   Workflow: ${check.workflowName ?? "unknown"}`,
			`   Status: ${checkBucket(check)}${check.state ? ` (${check.state})` : ""}`,
			`   Conclusion: ${check.conclusion ?? "unknown"}`,
			`   Details: ${check.detailsUrl ?? "unknown"}`,
			`   Description: ${(check.description ?? "unknown").replace(/\s+/g, " ").slice(0, 800)}`,
			""
		);
	}
	if (failing.length === 0) {
		lines.push("No failing checks were reported by GitHub.");
	}
	return lines.join("\n").slice(0, MAX_REPORT_CHARS);
}

/** Build a bounded, metadata-only report for the user-triggered merge-conflict
 * Fix action. The report gives the next chat turn the branch and GitHub state,
 * without copying repository contents or credentials into the composer. */
export function buildPullRequestMergeConflictReport(
	pullRequest: GitPullRequest
): string {
	const lines = [
		"Ryu merge conflict report",
		"",
		reportLine("Pull request", `#${pullRequest.number} ${pullRequest.title}`),
		reportLine("URL", pullRequest.url),
		reportLine("Repository", pullRequest.repository),
		reportLine("Branch", pullRequest.headRefName ?? pullRequest.branch),
		reportLine("Base", pullRequest.baseRefName),
		reportLine("Head SHA", pullRequest.headRefOid),
		reportLine("Mergeable", pullRequest.mergeable),
		reportLine("Merge state", pullRequest.mergeStateStatus),
		"",
		"GitHub reports merge conflicts for this pull request.",
		"Inspect the local project, resolve the conflicts, and verify the result before committing.",
	];
	return lines.join("\n").slice(0, MAX_REPORT_CHARS);
}

export async function fetchPullRequestForBranch(
	target: ApiTarget,
	cwd: string,
	branch: string,
	signal?: AbortSignal,
	state: GitPullRequestLookupState = "open"
): Promise<GitPullRequest | null> {
	const params = new URLSearchParams({ branch, cwd, state });
	const response = await ownAppRequest(target, PULL_REQUESTS_APP_ID, {
		path: `/pulls/branch?${params.toString()}`,
		signal,
	});
	return pullRequestResponseSchema.parse(response).pull;
}

function pullRequestPath(reference: PullRequestReference): string {
	return `/pulls/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/${reference.number}`;
}

/** Read one pull request's full detail (checks, mergeability) by URL. */
export async function fetchPullRequestByUrl(
	target: ApiTarget,
	url: string,
	signal?: AbortSignal
): Promise<GitPullRequest | null> {
	const reference = parsePullRequestUrl(url);
	if (!reference) {
		return null;
	}
	const response = await ownAppRequest(target, PULL_REQUESTS_APP_ID, {
		path: pullRequestPath(reference),
		signal,
	});
	return gitPullRequestWireSchema.parse(response);
}

export interface PullRequestFeedbackSnapshot {
	feedback: PullRequestFeedback[];
	pullRequest: GitPullRequest | null;
}

/** Read one pull request's status and recent feedback through the app's light
 * feedback route: a single GitHub GraphQL call, without the files, commits,
 * checks, stack, and sub-issue lookups of the detail route. Throws when the
 * app or GitHub cannot be reached, so callers can tell a failed lookup from
 * an answer. */
export async function fetchPullRequestFeedback(
	target: ApiTarget,
	url: string,
	signal?: AbortSignal
): Promise<PullRequestFeedbackSnapshot> {
	const reference = parsePullRequestUrl(url);
	if (!reference) {
		return { feedback: [], pullRequest: null };
	}
	const response = await ownAppRequest(target, PULL_REQUESTS_APP_ID, {
		path: `${pullRequestPath(reference)}/feedback`,
		signal,
	});
	return {
		feedback: pullRequestFeedbackSchema.parse(response),
		pullRequest: gitPullRequestWireSchema.parse(response),
	};
}

export async function fetchGitHubRepository(
	target: ApiTarget,
	cwd: string,
	signal?: AbortSignal
): Promise<GitHubRepository | null> {
	const params = new URLSearchParams({ cwd });
	const response = await ownAppRequest(target, PULL_REQUESTS_APP_ID, {
		path: `/repository?${params.toString()}`,
		signal,
	});
	return gitHubRepositoryResponseSchema.parse(response).repository;
}

export async function createGitHubRepository(
	target: ApiTarget,
	cwd: string,
	input: {
		name: string;
		visibility: GitHubRepositoryVisibility;
	},
	signal?: AbortSignal
): Promise<GitHubRepository> {
	const response = await ownAppRequest(target, PULL_REQUESTS_APP_ID, {
		body: { cwd, name: input.name, visibility: input.visibility },
		method: "POST",
		path: "/repository/create",
		signal,
	});
	const repository = gitHubRepositoryResponseSchema.parse(response).repository;
	if (!repository) {
		throw new Error("GitHub did not return the created repository");
	}
	return repository;
}

/** Resolve the compare base without requiring the branch picker to be opened. */
export function selectGitHubCompareBaseBranch(
	pullRequestBase: string | null | undefined,
	repositoryDefaultBranch: string | null | undefined,
	localBranches: readonly string[]
): string {
	const configuredBase = [pullRequestBase, repositoryDefaultBranch]
		.map((value) => value?.trim())
		.find((value): value is string => Boolean(value));
	if (configuredBase) {
		return configuredBase;
	}
	if (localBranches.includes("main")) {
		return "main";
	}
	return localBranches.includes("master") ? "master" : "main";
}

/** Build GitHub's compare view for the current branch against its configured base. */
export function buildGitHubCompareUrl(
	repository: Pick<GitHubRepository, "url">,
	currentBranch: string,
	baseBranch: string
): string | null {
	const branch = currentBranch.trim();
	const base = baseBranch.trim();
	if (!(branch && base) || branch === base) {
		return null;
	}
	try {
		const repositoryUrl = new URL(repository.url);
		const repositoryPath = repositoryUrl.pathname.replace(/\/+$/, "");
		if (!repositoryPath || repositoryUrl.protocol !== "https:") {
			return null;
		}
		return `${repositoryUrl.origin}${repositoryPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
	} catch {
		return null;
	}
}
