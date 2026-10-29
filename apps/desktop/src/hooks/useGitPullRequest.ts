import { useQuery } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchPullRequestByUrl,
	fetchPullRequestFeedback,
	fetchPullRequestForBranch,
	type GitPullRequest,
	type GitPullRequestLookupState,
	gitPullRequestStatus,
	type PullRequestFeedbackSnapshot,
} from "@/src/lib/api/pull-requests.ts";
import { queryClient } from "@/src/lib/query-client.ts";
import { canonicalCwd } from "./useGitStatus.ts";

const POLL_INTERVAL_MS = 30_000;
const FRESH_MS = 10_000;

function gitPullRequestKeyPrefix(
	cwd: string | null,
	branch: string | null
): [string, string, string] {
	return [
		"git-pull-request",
		cwd ? canonicalCwd(cwd) : "",
		branch?.trim() ?? "",
	];
}

export function gitPullRequestKey(
	cwd: string | null,
	branch: string | null,
	state: GitPullRequestLookupState = "open"
): [string, string, string, GitPullRequestLookupState] {
	return [...gitPullRequestKeyPrefix(cwd, branch), state];
}

export interface GitPullRequestResult {
	data: GitPullRequest | null;
	isLoading: boolean;
}

/** Read the PR owned by the current branch through the optional Pull Requests
 * app. A disabled/unavailable app is treated as no metadata, so local Git
 * actions remain usable without turning the Environment row into an error. */
export function useGitPullRequest(
	target: ApiTarget,
	cwd: string | null,
	branch: string | null,
	enabled: boolean,
	state: GitPullRequestLookupState = "open"
): GitPullRequestResult {
	const normalizedBranch = branch?.trim() || null;
	const observing = enabled && Boolean(cwd && normalizedBranch);
	const { data, isLoading } = useQuery({
		queryKey: [
			...gitPullRequestKey(cwd, normalizedBranch, state),
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		],
		queryFn: ({ signal }) =>
			fetchPullRequestForBranch(
				target,
				canonicalCwd(cwd ?? ""),
				normalizedBranch ?? "",
				signal,
				state
			).catch(() => null),
		enabled: observing,
		subscribed: observing,
		gcTime: 60_000,
		refetchInterval: POLL_INTERVAL_MS,
		refetchOnMount: true,
		refetchOnWindowFocus: true,
		staleTime: FRESH_MS,
	});

	return { data: data ?? null, isLoading };
}

export function invalidateGitPullRequest(
	cwd?: string | null,
	branch?: string | null
): void {
	queryClient.invalidateQueries({
		queryKey:
			cwd && branch
				? gitPullRequestKeyPrefix(cwd, branch)
				: ["git-pull-request"],
	});
}

/** Full detail (checks, mergeability) for a pull request explicitly linked to
 * a chat. The detail route also reads files, commits, stacks, and sub-issues,
 * so only surfaces mounted on demand (the hover card) use it; row icons use
 * {@link useLinkedPullRequestStatus}. */
export function useLinkedPullRequest(
	target: ApiTarget,
	url: string,
	enabled: boolean
): GitPullRequestResult {
	const { data, isLoading } = useQuery({
		queryKey: [
			"git-pull-request",
			"linked",
			url,
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		],
		queryFn: ({ signal }) =>
			fetchPullRequestByUrl(target, url, signal).catch(() => null),
		enabled,
		subscribed: enabled,
		gcTime: 60_000,
		refetchInterval: POLL_INTERVAL_MS * 2,
		refetchOnWindowFocus: true,
		staleTime: FRESH_MS,
	});
	return { data: data ?? null, isLoading };
}

/** Status refresh for linked pull request icons; the automation watcher's own
 * polling refreshes the same cache entry while it runs. */
const LINKED_STATUS_INTERVAL_MS = 2 * 60_000;
/** Merged is final and closed rarely reopens, so re-read them less often. */
const LINKED_STATUS_MERGED_INTERVAL_MS = 30 * 60_000;
const LINKED_STATUS_CLOSED_INTERVAL_MS = 10 * 60_000;
/** After a failed lookup, wait longer before asking GitHub again. Shared with
 * the automation watcher, which skips a recently failed pull request. */
export const LINKED_STATUS_FAILURE_INTERVAL_MS = 10 * 60_000;
const LINKED_STATUS_FRESH_MS = 50_000;

/** How long a linked pull request's status may go without a refresh. */
export function linkedPullRequestRefreshMs(
	failed: boolean,
	snapshot: PullRequestFeedbackSnapshot | undefined
): number {
	if (failed) {
		return LINKED_STATUS_FAILURE_INTERVAL_MS;
	}
	const pullRequest = snapshot?.pullRequest;
	const status = pullRequest ? gitPullRequestStatus(pullRequest) : null;
	if (status === "merged") {
		return LINKED_STATUS_MERGED_INTERVAL_MS;
	}
	return status === "closed"
		? LINKED_STATUS_CLOSED_INTERVAL_MS
		: LINKED_STATUS_INTERVAL_MS;
}

/** One cache entry per linked pull request for the light status-and-feedback
 * route, shared by row icons and the automation watcher so neither repeats
 * the other's GitHub request. The query function throws on failure, so a
 * failed lookup is never mistaken for a closed pull request. */
export function linkedPullRequestFeedbackQuery(target: ApiTarget, url: string) {
	return {
		queryFn: ({ signal }: { signal: AbortSignal }) =>
			fetchPullRequestFeedback(target, url, signal),
		queryKey: [
			"git-pull-request",
			"linked-feedback",
			url,
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		],
		staleTime: LINKED_STATUS_FRESH_MS,
	};
}

/** Status and title of a pull request explicitly linked to a chat, for row
 * icons and the link dialog. */
export function useLinkedPullRequestStatus(
	target: ApiTarget,
	url: string,
	enabled: boolean
): GitPullRequestResult {
	const { data, isLoading } = useQuery({
		...linkedPullRequestFeedbackQuery(target, url),
		enabled,
		subscribed: enabled,
		gcTime: 10 * 60_000,
		refetchInterval: (query) =>
			linkedPullRequestRefreshMs(
				query.state.status === "error",
				query.state.data
			),
		refetchOnWindowFocus: true,
		retry: false,
		select: (snapshot: PullRequestFeedbackSnapshot) => snapshot.pullRequest,
	});
	return { data: data ?? null, isLoading };
}
