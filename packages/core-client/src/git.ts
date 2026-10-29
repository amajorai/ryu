import { z } from "zod";
import { appJsonValueSchema } from "./app-request-json.ts";
// apps/desktop/src/lib/api/git.ts
//
// Typed client for Core's git endpoints:
//   - `GET /api/git/status?cwd=<path>` (consumed by WorkspacePicker)
//   - `GET /api/worktree/:run_id/diff` (consumed by DiffReviewPane)
//   - `POST /api/worktree/:run_id/apply` (consumed by DiffReviewPane)

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";

/** Validate complete native Git response fields at Response.json, retaining the
 * original decoded receivers, nested arrays and all future JSON metadata. The
 * omitted/nullish fields keep the existing non-repo and legacy fallbacks. */
function gitResponseSchema<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const gitStatusSchema = gitResponseSchema(
	z.object({
		ahead: z.number().nullish(),
		behind: z.number().nullish(),
		branch: z.string().nullish(),
		changed_files_count: z.number().nullish(),
		dirty: z.boolean().nullish(),
		is_repo: z.boolean().nullish(),
		insertions: z.number().nullish(),
		deletions: z.number().nullish(),
		error: z.string().nullish(),
	})
);
const nativeGitPathListSchema = z.custom<string[]>(
	(value) => z.array(z.string()).safeParse(value).success
);
const gitBranchesSchema = gitResponseSchema(
	z.object({
		branches: nativeGitPathListSchema.nullish(),
		current: z.string().nullish(),
		is_repo: z.boolean().nullish(),
		error: z.string().nullish(),
	})
);
const gitCheckoutSchema = gitResponseSchema(
	z.object({
		success: z.boolean().nullish(),
		branch: z.string().nullish(),
		error: z.string().nullish(),
	})
);
const nativeGitFileSummarySchema = gitResponseSchema(
	z.object({
		path: z.string(),
		kind: z.enum(["added", "modified", "deleted", "renamed"]),
		additions: z.number(),
		deletions: z.number(),
	})
);
const nativeGitFileListSchema = z.custom<
	z.output<typeof nativeGitFileSummarySchema>[]
>((value) => z.array(nativeGitFileSummarySchema).safeParse(value).success);
const gitDiffSchema = gitResponseSchema(
	z.object({
		files: nativeGitFileListSchema.nullish(),
		has_changes: z.boolean().nullish(),
		unified_diff: z.string().nullish(),
		error: z.string().nullish(),
	})
);
const gitApplySchema = gitResponseSchema(
	z.object({
		conflicted_files: nativeGitPathListSchema.nullish(),
		error: z.string().nullish(),
		commit: z.string().nullish(),
		pr_url: z.string().nullish(),
		success: z.boolean().nullish(),
		run_id: z.string().nullish(),
	})
);

export interface GitStatus {
	ahead: number;
	behind: number;
	branch: string | null;
	changed_files_count: number;
	dirty: boolean;
	is_repo: boolean;
}

const NOT_REPO: GitStatus = {
	is_repo: false,
	branch: null,
	ahead: 0,
	behind: 0,
	dirty: false,
	changed_files_count: 0,
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
		const resp = await fetchForTarget(target)(url, {
			method: "GET",
			headers: makeHeaders(target.token, target.userJwt),
			signal,
		});
		if (!resp.ok) {
			return NOT_REPO;
		}
		const json = gitStatusSchema.parse(await resp.json());
		return {
			is_repo: json.is_repo ?? false,
			branch: json.branch ?? null,
			ahead: json.ahead ?? 0,
			behind: json.behind ?? 0,
			dirty: json.dirty ?? false,
			changed_files_count: json.changed_files_count ?? 0,
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
		const resp = await fetchForTarget(target)(url, {
			method: "GET",
			headers: makeHeaders(target.token, target.userJwt),
			signal,
		});
		if (!resp.ok) {
			return NO_BRANCHES;
		}
		const json = gitBranchesSchema.parse(await resp.json());
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
		const resp = await fetchForTarget(target)(url, {
			method: "POST",
			headers: {
				...makeHeaders(target.token, target.userJwt),
				"content-type": "application/json",
			},
			body: JSON.stringify({ cwd, branch }),
			signal,
		});
		const json = gitCheckoutSchema.parse(await resp.json());
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
	const resp = await fetchForTarget(target)(url, {
		method: "POST",
		headers: {
			...makeHeaders(target.token, target.userJwt),
			"content-type": "application/json",
		},
		body: JSON.stringify(opts),
		signal,
	});
	const json = gitApplySchema.parse(await resp.json());
	if (resp.status === 409) {
		return {
			success: false,
			error: "merge_conflict",
			conflicted_files: json.conflicted_files ?? [],
		};
	}
	if (!resp.ok) {
		throw new Error(json.error ?? `apply failed: ${resp.status}`);
	}
	return {
		success: true,
		commit: json.commit ?? null,
		pr_url: json.pr_url ?? null,
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
		const resp = await fetchForTarget(target)(url, {
			method: "GET",
			headers: makeHeaders(target.token, target.userJwt),
			signal,
		});
		if (!resp.ok) {
			return EMPTY_DIFF;
		}
		const json = gitDiffSchema.parse(await resp.json());
		return {
			has_changes: json.has_changes ?? false,
			files: json.files ?? [],
			unified_diff: json.unified_diff ?? "",
		};
	} catch {
		return EMPTY_DIFF;
	}
}
