// apps/desktop/src/hooks/useGitStatus.ts
//
// The single source of truth for "what does git say about this folder" in the
// desktop. Every surface that shows a branch, a dirty dot, or a +/− count reads
// it from here, so they can never disagree with each other.
//
// Before this hook each consumer (the branch picker, the worktree picker, the
// unified WorkspacePicker that has since replaced both, and PinnedSummaryPanel)
// called `fetchGitStatus` from its own
// effect on its own schedule: two of them polled every 5s from independently
// started timers, two fetched exactly once and then never again. That is why the
// numbers drifted — not because any one of them was wrong, but because they were
// each right about a different moment.
//
// The cache key includes the node credentials and canonical working directory.
// Branch is *output*, not
// part of the key: keying on folder+branch would mint a fresh entry on every
// checkout and leave the old one behind, still holding the numbers from before
// the switch. A git worktree is not a third axis either — it is simply a
// different working directory, so `~/proj` and `~/proj/.claude/worktrees/foo`
// are two keys, which is correct.
//
// ── When these queries re-read git, and why ──────────────────────────────────
//
// Three triggers, in order of how much of the problem each one actually solves:
//
//  1. **Window focus.** To run git OUTSIDE Ryu — commit, reset, checkout, pull —
//     the user has to leave this window and come back. So focus is not a
//     heuristic here, it is the exact event: every out-of-app change is followed
//     by a focus, and every focus is cheap (one read per open folder). The
//     app-wide client sets `refetchOnWindowFocus: false` (right for slow-moving
//     catalog data), so each query below opts back IN explicitly. Without this
//     the number stayed whatever it was when the user tabbed away — the "silently
//     wrong for hours" failure. Note this only works because `query-client.ts`
//     teaches TanStack what focus means on a desktop: out of the box v5 watches
//     `visibilitychange` alone, which a cmd-tab away from a still-visible window
//     never fires.
//  2. **Explicit invalidation** after anything Ryu itself does: checkout, branch
//     create, commit/push, worktree apply, and the end of an agent turn (the
//     moment a run's edits have all landed). See `invalidate*` below.
//  3. **A slow poll**, as a safety net only, for changes no one announced (a
//     background `git gc`, an editor writing files, a long agent run mid-flight).
//     15s, not 5s: one read is 3-4 `git` subprocesses against the whole worktree,
//     it runs per open folder for as long as the app is up, and (1)+(2) already
//     cover every case a human would notice. TanStack pauses the interval while
//     the window is unfocused, so an idle background app polls nothing at all.
//
// What is deliberately NOT a trigger: typing, rendering, or any per-keystroke
// event. Git status is a process spawn, not a state read.

import { useQuery } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGitStatus,
	fetchWorktreeDiff,
	fetchWorktreeStatus,
	type GitStatus,
	type WorktreeDiff,
	type WorktreeStatus,
} from "@/src/lib/api/git.ts";
import { queryClient } from "@/src/lib/query-client.ts";

/** Safety-net poll interval for the shared queries; see the header note on
 *  why this is a backstop rather than the primary freshness mechanism. */
const POLL_INTERVAL_MS = 15_000;

const NOT_REPO: GitStatus = {
	is_repo: false,
	branch: null,
	ahead: 0,
	behind: 0,
	dirty: false,
	changed_files_count: 0,
	insertions: 0,
	deletions: 0,
};

const TRAILING_SEPARATORS = /[\\/]+$/;

/**
 * Canonical form of a workspace path, so `/repo` and `/repo/` share one cache
 * entry instead of polling git twice and rendering two different answers.
 */
export function canonicalCwd(cwd: string): string {
	const trimmed = cwd.trim().replace(TRAILING_SEPARATORS, "");
	return trimmed === "" ? cwd.trim() : trimmed;
}

/** Logical query prefix, exported for invalidation across node scopes. */
export function gitStatusKey(cwd: string | null): [string, string] {
	return ["git-status", cwd ? canonicalCwd(cwd) : ""];
}

export interface GitStatusResult {
	isLoading: boolean;
	status: GitStatus;
}

/**
 * Live git status for `cwd`, shared across every component that asks for the
 * same folder: TanStack Query dedupes concurrent mounts onto one in-flight
 * request and hands them all the identical object. Poll timers are owned by
 * individual query observers.
 *
 * Returns the non-repo shape (rather than `undefined`) while loading or when the
 * folder is not a repo, so callers can render `status.is_repo` directly.
 */
export function useGitStatus(
	target: ApiTarget,
	cwd: string | null
): GitStatusResult {
	const { data, isLoading } = useQuery({
		queryKey: [
			...gitStatusKey(cwd),
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		],
		queryFn: ({ signal }) =>
			fetchGitStatus(target, canonicalCwd(cwd ?? ""), signal),
		enabled: Boolean(cwd),
		refetchInterval: POLL_INTERVAL_MS,
		// Re-read the moment the user comes back — that is when an out-of-app git
		// command has just happened. The app-wide default is `false`.
		refetchOnWindowFocus: true,
		// A thread may mount after another thread (or an external terminal) changed
		// this worktree. Do not make the new thread wait for the shared poll timer;
		// it should verify the branch immediately while still sharing the result
		// with every other mounted thread.
		refetchOnMount: "always",
		// The point of this hook is freshness, so opt out of the app-wide
		// 5-minute staleTime that suits slow-moving catalog data.
		staleTime: 0,
		gcTime: 60_000,
	});

	return { status: data ?? NOT_REPO, isLoading: isLoading && Boolean(cwd) };
}

/**
 * Force every mounted consumer to re-read git for `cwd` now.
 *
 * Call this straight after any action that changes the tree — checkout, branch
 * create, commit/push, worktree apply — instead of refreshing only the component
 * that performed it. That local-refresh-only habit is what left the other panels
 * showing pre-commit numbers until their own timer happened to fire.
 *
 * Pass no argument to refresh every folder (useful when the change could have
 * touched a worktree as well as its parent repo).
 */
export function invalidateGitStatus(cwd?: string | null): void {
	queryClient.invalidateQueries({
		queryKey: cwd ? gitStatusKey(cwd) : ["git-status"],
	});
}

// ── Per-conversation worktree status ─────────────────────────────────────────
//
// Same problem, same shape: the old worktree picker and WorkspacePicker each polled
// `/api/worktree/:run_id/status` on their own timer. Keyed by conversation id
// because that is what the endpoint is keyed by.

const NO_WORKTREE: WorktreeStatus = {
	active: false,
	branch: null,
	path: null,
	has_changes: false,
	changed_files: 0,
};

/** Logical worktree query prefix, shared by all node scopes. */
export function worktreeStatusKey(
	conversationId: string | null | undefined
): [string, string] {
	return ["worktree-status", conversationId ?? ""];
}

/**
 * Live worktree status for a conversation, shared across every consumer the same
 * way {@link useGitStatus} shares repo status.
 */
export function useWorktreeStatus(
	target: ApiTarget,
	conversationId: string | null | undefined
): WorktreeStatus {
	const { data } = useQuery({
		queryKey: [
			...worktreeStatusKey(conversationId),
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		],
		queryFn: ({ signal }) =>
			fetchWorktreeStatus(target, conversationId ?? "", signal),
		enabled: Boolean(conversationId),
		refetchInterval: POLL_INTERVAL_MS,
		refetchOnWindowFocus: true,
		staleTime: 0,
		gcTime: 60_000,
	});

	return data ?? NO_WORKTREE;
}

/** Force a re-read of one conversation's worktree status (or all of them). */
export function invalidateWorktreeStatus(conversationId?: string | null): void {
	queryClient.invalidateQueries({
		queryKey: conversationId
			? worktreeStatusKey(conversationId)
			: ["worktree-status"],
	});
}

// ── Per-conversation worktree DIFF ───────────────────────────────────────────
//
// The +added/−removed totals and the per-file list behind the Changes section,
// the Artifacts list and the run-mode chip. Core recomputes this from the live
// worktree on every read (it used to answer with a snapshot taken when the run
// finished — the number that stayed on screen long after the change was
// committed, reset or discarded outside the app).
//
// It is here, next to status, for the same reason status is: three consumers
// (DiffReviewPane, CoworkContextPanel, WorkspacePicker) each fetched it from
// their own effect on their own trigger — one on mount only, one per turn
// transition, one on worktree-status changes — so the same run could show three
// different totals. One query, one answer, one refetch schedule.

const EMPTY_DIFF: WorktreeDiff = {
	has_changes: false,
	files: [],
	unified_diff: "",
};

/** Logical worktree-diff query prefix, shared by all node scopes. */
export function worktreeDiffKey(
	conversationId: string | null | undefined
): [string, string] {
	return ["worktree-diff", conversationId ?? ""];
}

/**
 * The live aggregate diff for a conversation's worktree, shared across every
 * consumer. Returns the empty diff while loading, when the conversation never
 * ran in a worktree, or when Core is unreachable — callers render `has_changes`
 * directly rather than handling an error state.
 *
 * No poll: a diff read is heavier than a status read (it walks every changed
 * file), and the two events that can change it — an agent turn finishing and the
 * user doing something to the tree — are both announced (turn end invalidates;
 * an out-of-app change is followed by a window focus).
 */
export function useWorktreeDiff(
	target: ApiTarget,
	conversationId: string | null | undefined
): WorktreeDiff {
	const { data } = useQuery({
		queryKey: [
			...worktreeDiffKey(conversationId),
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		],
		queryFn: ({ signal }) =>
			fetchWorktreeDiff(target, conversationId ?? "", signal),
		enabled: Boolean(conversationId),
		refetchOnWindowFocus: true,
		staleTime: 0,
		gcTime: 60_000,
	});

	return data ?? EMPTY_DIFF;
}

/** Force a re-read of one conversation's worktree diff (or all of them). */
export function invalidateWorktreeDiff(conversationId?: string | null): void {
	queryClient.invalidateQueries({
		queryKey: conversationId
			? worktreeDiffKey(conversationId)
			: ["worktree-diff"],
	});
}
