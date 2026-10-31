// Pure unified-diff helpers, kept apart from the diff renderer so callers that
// only slice patches do not load @pierre/diffs.

const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/gm;

/** Pull one file's patch out of a multi-file unified diff. */
export function patchForFile(unifiedDiff: string, path: string): string {
	const matches = [...unifiedDiff.matchAll(DIFF_HEADER_RE)];
	if (matches.length === 0) {
		return unifiedDiff;
	}
	const matchIndex = matches.findIndex(
		(match) => match[1] === path || match[2] === path
	);
	if (matchIndex < 0) {
		return unifiedDiff;
	}
	const start = matches[matchIndex]?.index ?? 0;
	const end = matches[matchIndex + 1]?.index ?? unifiedDiff.length;
	return unifiedDiff.slice(start, end).trimEnd();
}

/** Split a git patch into the single-file patches expected by PatchDiff. */
export function splitPatchByFile(
	patch: string
): { path: string; patch: string }[] {
	return patch
		.split(/\n(?=diff --git )/)
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map((chunk) => {
			const match = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
			return {
				path: match?.[2] ?? chunk.slice(0, 60),
				patch: chunk,
			};
		});
}
