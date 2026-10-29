import type { FileDiffLine } from "@ryu/ui/components/agents/file-diff";

/**
 * A minimal line diff over two strings, emitting the beUI `FileDiffLine` shape
 * (added / removed / context rows with running old/new line numbers). LCS-based
 * so the common edit — a small change in the middle of a big file — keeps its
 * unchanged context instead of re-emitting every line as a removal + addition.
 *
 * Lives here (a pure module with only a type-only `@ryu/ui` import) rather than
 * inside `edit-tool.tsx` so `bun test` can exercise it: the app resolves
 * `@ryu/ui/components/*` without extensions, `bun test` does not, and a `.ts`
 * module whose only `@ryu/ui` reference is a type import is erased before the
 * resolver runs.
 */
export function diffLines(oldText: string, newText: string): FileDiffLine[] {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	// LCS table over line indices.
	const lcs = Array.from({ length: oldLines.length + 1 }, () =>
		Array.from({ length: newLines.length + 1 }, () => 0)
	);
	for (let i = oldLines.length - 1; i >= 0; i -= 1) {
		for (let j = newLines.length - 1; j >= 0; j -= 1) {
			lcs[i]![j] =
				oldLines[i] === newLines[j]
					? (lcs[i + 1]![j + 1] ?? 0) + 1
					: Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
		}
	}

	const lines: FileDiffLine[] = [];
	let i = 0;
	let j = 0;
	let oldLine = 1;
	let newLine = 1;
	const push = (
		type: FileDiffLine["type"],
		content: string,
		o: number | undefined,
		n: number | undefined
	) => {
		lines.push({
			id: `${lines.length}-${type}`,
			type,
			content,
			oldLine: o,
			newLine: n,
		});
	};

	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			push("context", oldLines[i]!, oldLine, newLine);
			i += 1;
			j += 1;
			oldLine += 1;
			newLine += 1;
		} else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
			push("removed", oldLines[i]!, oldLine, undefined);
			i += 1;
			oldLine += 1;
		} else {
			push("added", newLines[j]!, undefined, newLine);
			j += 1;
			newLine += 1;
		}
	}
	while (i < oldLines.length) {
		push("removed", oldLines[i]!, oldLine, undefined);
		i += 1;
		oldLine += 1;
	}
	while (j < newLines.length) {
		push("added", newLines[j]!, undefined, newLine);
		j += 1;
		newLine += 1;
	}
	return lines;
}
