// apps/desktop/src/components/agents/AnnotationQueuesPanel-parsing.ts
//
// Input parsing helpers shared by the annotation queue panel pieces.

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Split a comma-separated label list into trimmed, unique, non-empty labels. */
export function parseLabelList(raw: string): string[] {
	const labels: string[] = [];
	for (const part of raw.split(",")) {
		const label = part.trim();
		if (label && !labels.includes(label)) {
			labels.push(label);
		}
	}
	return labels;
}

/** Parse a score field; `undefined` when blank, `null` when not a number. */
export function parseScore(raw: string): number | null | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return;
	}
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : null;
}
