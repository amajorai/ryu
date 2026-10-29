// Command-palette row windowing. Pure so it can be unit-tested without a
// renderer. Grouped rows cost extra lines: the first visible row of a group is
// preceded by its header, and every later group also by a blank spacer line, so
// the window is measured in terminal lines rather than in rows. This keeps the
// panel inside short terminals (80x24 and below) whatever groups are in view.

export interface PaletteWindow {
	/** Exclusive end row index. */
	end: number;
	/** First visible row index. */
	start: number;
}

/** Lines row `row` occupies when the window starts at `start`. */
function rowLines(
	groups: readonly string[] | null,
	row: number,
	start: number
): number {
	if (!groups) {
		return 1;
	}
	if (row === start) {
		return 2;
	}
	return groups[row] === groups[row - 1] ? 1 : 3;
}

function windowFits(
	groups: readonly string[] | null,
	window: PaletteWindow,
	lineBudget: number,
	maxRows: number
): boolean {
	if (window.end - window.start > maxRows) {
		return false;
	}
	let lines = 0;
	for (let row = window.start; row < window.end; row += 1) {
		lines += rowLines(groups, row, window.start);
	}
	return lines <= lineBudget;
}

/**
 * Pick the visible slice of `count` rows so `index` stays visible, at most
 * `maxRows` rows are shown and they (plus any group headers/spacers, when
 * `groups` names each row's group) fit in `lineBudget` lines. The selection is
 * always shown, even when the budget is smaller than one row.
 */
export function paletteWindow(
	count: number,
	index: number,
	lineBudget: number,
	maxRows: number,
	groups: readonly string[] | null = null
): PaletteWindow {
	if (count <= 0) {
		return { end: 0, start: 0 };
	}
	const selected = Math.min(Math.max(0, index), count - 1);
	let start = 0;
	while (
		start < selected &&
		!windowFits(groups, { end: selected + 1, start }, lineBudget, maxRows)
	) {
		start += 1;
	}
	let end = selected + 1;
	while (
		end < count &&
		windowFits(groups, { end: end + 1, start }, lineBudget, maxRows)
	) {
		end += 1;
	}
	return { end, start };
}
