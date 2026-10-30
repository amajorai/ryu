import type { FileContents } from "@pierre/diffs";

// ── Code review panel (@pierre/diffs) ────────────────────────────────────────

// What the diff is computed against. The git command for each lives in
// `buildDiffCommand` below — nothing about the source is hardcoded into render.
export type DiffMode = "working" | "staged" | "commit" | "branch";

export interface CommitInfo {
	sha: string;
	subject: string;
}

export interface FullDiffFiles {
	newFile: FileContents | null;
	oldFile: FileContents | null;
}

// `%x09` makes git emit a real tab between the hash and the subject, so we let
// git insert the delimiter instead of pushing a control char through the shell.
export const GIT_LOG_FORMAT = "%H%x09%s";

export function shortSha(sha: string) {
	return sha.slice(0, 7);
}

// `shell_execute` runs the command string through a full shell (`bash -c` /
// `powershell -Command`), and git ref names can legally contain shell
// metacharacters (`$ ; ( ) & |` …), so interpolating a ref/SHA from an untrusted
// repo could inject commands or git flags. Allow only safe ref characters and
// reject a leading `-` (argument injection). Refs that fail validation fall
// through to the safe default below rather than being interpolated.
const SAFE_GIT_REF = /^[A-Za-z0-9._/-]+$/;
function isSafeGitRef(ref: string): boolean {
	return ref.length > 0 && !ref.startsWith("-") && SAFE_GIT_REF.test(ref);
}

export function buildDiffCommand(
	mode: DiffMode,
	commit: CommitInfo | null,
	branch: string | null
): string {
	if (mode === "staged") {
		return "git diff --staged";
	}
	if (mode === "commit" && commit && isSafeGitRef(commit.sha)) {
		// `--root` makes the initial commit diff against the empty tree.
		return `git diff-tree -p --no-commit-id --root ${commit.sha}`;
	}
	if (mode === "branch" && branch && isSafeGitRef(branch)) {
		// Symmetric range: what this branch added since it diverged from `branch`.
		return `git diff ${branch}...HEAD`;
	}
	// "working" / default: every uncommitted change vs HEAD.
	return "git diff HEAD";
}

// Files beyond this index are rendered collapsed once a patch touches more than
// LARGE_PATCH_FILE_COUNT files — collapsed diffs skip syntax highlighting until
// the user expands them, which keeps a 50-file review from tokenizing everything
// up front. Small diffs (the common case) are unaffected.
export const EAGER_DIFF_FILE_COUNT = 15;
export const LARGE_PATCH_FILE_COUNT = 20;

export interface FileReviewRequest {
	nonce: number;
	paths: string[];
}
