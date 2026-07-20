// apps/desktop/src/lib/api/git.ts
//
// Typed client for Core's git endpoints:
//   - `GET /api/git/status?cwd=<path>` (consumed by WorkspaceHeader)
//   - `GET /api/worktree/:run_id/diff` (consumed by DiffReviewPane)
//   - `POST /api/worktree/:run_id/apply` (consumed by DiffReviewPane)

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

export interface GitStatus {
	ahead: number;
	behind: number;
	branch: string | null;
	changed_files_count: number;
	deletions: number;
	dirty: boolean;
	insertions: number;
	is_repo: boolean;
}

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

/**
 * Fetch git status for `cwd` from Core. Returns `{is_repo:false}` when the
 * folder is not a git repo or when Core is unreachable — callers should treat
 * any non-repo result as "hide the header" rather than an error.
 */
export async function fetchGitStatus(
	target: ApiTarget,
	cwd: string,
	signal?: AbortSignal
): Promise<GitStatus> {
	const url = `${apiUrl(target, "/api/git/status")}?cwd=${encodeURIComponent(cwd)}`;
	try {
		const resp = await fetch(url, {
			method: "GET",
			headers: makeHeaders(target.token),
			signal,
		});
		if (!resp.ok) {
			return NOT_REPO;
		}
		const json = (await resp.json()) as Partial<GitStatus>;
		return {
			is_repo: json.is_repo ?? false,
			branch: json.branch ?? null,
			ahead: json.ahead ?? 0,
			behind: json.behind ?? 0,
			dirty: json.dirty ?? false,
			changed_files_count: json.changed_files_count ?? 0,
			insertions: json.insertions ?? 0,
			deletions: json.deletions ?? 0,
		};
	} catch {
		return NOT_REPO;
	}
}

// ── Branch list + switch (composer branch selector) ──────────────────────────

export interface GitBranches {
	branches: string[];
	current: string | null;
	is_repo: boolean;
}

const NO_BRANCHES: GitBranches = {
	is_repo: false,
	current: null,
	branches: [],
};

/**
 * List local branches (plus the current one) for `cwd`. Returns an empty,
 * non-repo result when the folder is not a git repo or Core is unreachable, so
 * callers can treat any empty result as "nothing to switch."
 */
export async function fetchGitBranches(
	target: ApiTarget,
	cwd: string,
	signal?: AbortSignal
): Promise<GitBranches> {
	const url = `${apiUrl(target, "/api/git/branches")}?cwd=${encodeURIComponent(cwd)}`;
	try {
		const resp = await fetch(url, {
			method: "GET",
			headers: makeHeaders(target.token),
			signal,
		});
		if (!resp.ok) {
			return NO_BRANCHES;
		}
		const json = (await resp.json()) as Partial<GitBranches>;
		return {
			is_repo: json.is_repo ?? false,
			current: json.current ?? null,
			branches: json.branches ?? [],
		};
	} catch {
		return NO_BRANCHES;
	}
}

export interface CheckoutResult {
	branch?: string;
	error?: string;
	success: boolean;
}

/**
 * Switch `cwd` to an existing local branch. Resolves with `{success:false,error}`
 * on a git failure (e.g. uncommitted changes that would be overwritten) so the
 * caller can surface the message rather than throw.
 */
export async function checkoutBranch(
	target: ApiTarget,
	cwd: string,
	branch: string,
	signal?: AbortSignal
): Promise<CheckoutResult> {
	const url = apiUrl(target, "/api/git/checkout");
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				...makeHeaders(target.token),
				"content-type": "application/json",
			},
			body: JSON.stringify({ cwd, branch }),
			signal,
		});
		const json = (await resp.json()) as Partial<CheckoutResult>;
		if (!resp.ok) {
			return {
				success: false,
				error: json.error ?? `checkout failed: ${resp.status}`,
			};
		}
		return { success: true, branch: json.branch ?? branch };
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? e.message : "checkout failed",
		};
	}
}

/**
 * Create a new branch off the current HEAD in `cwd` and switch to it
 * (`git switch -c`). Resolves with `{success:false,error}` on a git failure (e.g.
 * the branch already exists) so the caller can surface the message rather than
 * throw. The desktop only offers this when the working tree is clean.
 */
export async function createBranch(
	target: ApiTarget,
	cwd: string,
	branch: string,
	signal?: AbortSignal
): Promise<CheckoutResult> {
	const url = apiUrl(target, "/api/git/create-branch");
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				...makeHeaders(target.token),
				"content-type": "application/json",
			},
			body: JSON.stringify({ cwd, branch }),
			signal,
		});
		const json = (await resp.json()) as Partial<CheckoutResult>;
		if (!resp.ok) {
			return {
				success: false,
				error: json.error ?? `create branch failed: ${resp.status}`,
			};
		}
		return { success: true, branch: json.branch ?? branch };
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? e.message : "create branch failed",
		};
	}
}

// ── Commit + push (pinned-summary action) ────────────────────────────────────

export interface CommitPushResult {
	commit?: string | null;
	committed?: boolean;
	error?: string;
	pushed?: boolean;
	success: boolean;
}

export type GitCommitAction = "commit" | "commit-push" | "push";

/**
 * Stage everything, commit with `message` (defaulting server-side to
 * "Update via Ryu"), and push to the tracking remote for `cwd`. Resolves with
 * `{success:false,error}` on any git failure (nothing-to-commit is not an error;
 * a missing upstream is) so the caller can surface the message rather than throw.
 */
export async function commitPush(
	target: ApiTarget,
	cwd: string,
	message?: string,
	signal?: AbortSignal,
	action: GitCommitAction = "commit-push",
	includeUnstaged = true
): Promise<CommitPushResult> {
	const url = apiUrl(target, "/api/git/commit-push");
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				...makeHeaders(target.token),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				cwd,
				message,
				action,
				include_unstaged: includeUnstaged,
			}),
			signal,
		});
		const json = (await resp.json()) as Partial<CommitPushResult>;
		if (!resp.ok) {
			return {
				success: false,
				error: json.error ?? `commit/push failed: ${resp.status}`,
			};
		}
		return {
			success: true,
			committed: json.committed ?? false,
			pushed: json.pushed ?? false,
			commit: json.commit ?? null,
		};
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? e.message : "commit/push failed",
		};
	}
}

// ── Worktree diff (Unit U011) ─────────────────────────────────────────────────

export type FileChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface FileSummary {
	additions: number;
	deletions: number;
	kind: FileChangeKind;
	path: string;
}

export interface WorktreeDiff {
	files: FileSummary[];
	has_changes: boolean;
	unified_diff: string;
}

const EMPTY_DIFF: WorktreeDiff = {
	has_changes: false,
	files: [],
	unified_diff: "",
};

// ── Worktree status (persistent-session presence) ─────────────────────────────

export interface WorktreeStatus {
	/** True when a live worktree is held for the conversation (iterable). */
	active: boolean;
	/** The worktree's branch (`ryu/...`), present while active. */
	branch: string | null;
	changed_files: number;
	has_changes: boolean;
	/** Absolute worktree path, present while active. */
	path: string | null;
}

const NO_WORKTREE: WorktreeStatus = {
	active: false,
	branch: null,
	path: null,
	has_changes: false,
	changed_files: 0,
};

/**
 * Read whether a conversation currently has a live persistent worktree. Returns
 * an inactive status when none exists yet (e.g. before the first message) or
 * when Core is unreachable, so callers treat it as "no worktree" not an error.
 *
 * `runId` is the conversation id (the worktree store is keyed by conversation).
 */
export async function fetchWorktreeStatus(
	target: ApiTarget,
	runId: string,
	signal?: AbortSignal
): Promise<WorktreeStatus> {
	const url = apiUrl(
		target,
		`/api/worktree/${encodeURIComponent(runId)}/status`
	);
	try {
		const resp = await fetch(url, {
			method: "GET",
			headers: makeHeaders(target.token),
			signal,
		});
		if (!resp.ok) {
			return NO_WORKTREE;
		}
		const json = (await resp.json()) as Partial<WorktreeStatus>;
		return {
			active: json.active ?? false,
			branch: json.branch ?? null,
			path: json.path ?? null,
			has_changes: json.has_changes ?? false,
			changed_files: json.changed_files ?? 0,
		};
	} catch {
		return NO_WORKTREE;
	}
}

// ── Worktree apply (Unit U012) ────────────────────────────────────────────────

export type ApplyMode = "merge" | "pr";

export interface ApplyOptions {
	base?: string;
	message: string;
	mode: ApplyMode;
}

export interface ApplySuccess {
	commit: string | null;
	pr_url: string | null;
	success: true;
}

export interface ConflictError {
	conflicted_files: string[];
	error: "merge_conflict";
	success: false;
}

export type ApplyResult = ApplySuccess | ConflictError;

/**
 * Apply a completed run's changes: commit + merge into base (mode='merge') or
 * commit + push + open a PR (mode='pr'). Returns a conflict error (HTTP 409)
 * when the merge cannot complete cleanly — the worktree is still cleaned up.
 */
export async function applyWorktree(
	target: ApiTarget,
	runId: string,
	opts: ApplyOptions,
	signal?: AbortSignal
): Promise<ApplyResult> {
	const url = apiUrl(
		target,
		`/api/worktree/${encodeURIComponent(runId)}/apply`
	);
	const resp = await fetch(url, {
		method: "POST",
		headers: {
			...makeHeaders(target.token),
			"content-type": "application/json",
		},
		body: JSON.stringify(opts),
		signal,
	});
	const json = (await resp.json()) as Record<string, unknown>;
	if (resp.status === 409) {
		return {
			success: false,
			error: "merge_conflict",
			conflicted_files: (json.conflicted_files as string[] | undefined) ?? [],
		};
	}
	if (!resp.ok) {
		throw new Error(
			(json.error as string | undefined) ?? `apply failed: ${resp.status}`
		);
	}
	return {
		success: true,
		commit: (json.commit as string | null) ?? null,
		pr_url: (json.pr_url as string | null) ?? null,
	};
}

/**
 * Fetch the aggregate diff for a run's worktree from Core.
 *
 * `runId` is the `conversation_id` that was active when the run executed with
 * worktree isolation enabled. Core stores the diff keyed by conversation id
 * after each ACP run completes.
 *
 * Returns an empty diff when no diff is found (e.g. the run did not use
 * worktree isolation, or the run has not completed yet).
 */
export async function fetchWorktreeDiff(
	target: ApiTarget,
	runId: string,
	signal?: AbortSignal
): Promise<WorktreeDiff> {
	const url = apiUrl(target, `/api/worktree/${encodeURIComponent(runId)}/diff`);
	try {
		const resp = await fetch(url, {
			method: "GET",
			headers: makeHeaders(target.token),
			signal,
		});
		if (!resp.ok) {
			return EMPTY_DIFF;
		}
		const json = (await resp.json()) as Partial<WorktreeDiff>;
		return {
			has_changes: json.has_changes ?? false,
			files: json.files ?? [],
			unified_diff: json.unified_diff ?? "",
		};
	} catch {
		return EMPTY_DIFF;
	}
}
