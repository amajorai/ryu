// Pure layout helpers for the TabStrip: chip labels and the overflow window.
// Kept free of OpenTUI so the truncation and windowing rules are unit-testable.

import { displayWidth, truncateLabel } from "../sidebar/rows.ts";

/** Marks a pinned tab, between its index and title ("1:*Agents"). */
export const PIN_GLYPH = "*";
/** Close affordance shown on the active chip (click it, or middle-click any chip). */
export const CLOSE_GLYPH = "×";
/** Widest a chip label ("n:title") may grow before its title is cut with "…". */
export const MAX_TAB_LABEL = 20;

/**
 * The chip label for the tab at 1-based `index`: "n:title", with the pin glyph
 * before the title, the whole label fit into `max` columns with an ellipsis.
 */
export function formatTabLabel(
	index: number,
	title: string,
	max = MAX_TAB_LABEL,
	pinned = false
): string {
	const prefix = `${index}:${pinned ? PIN_GLYPH : ""}`;
	const room = Math.max(1, max - displayWidth(prefix));
	return `${prefix}${truncateLabel(title, room)}`;
}

/** The leading overflow marker for `count` hidden tabs ("‹ +3"). */
export function leadingOverflowLabel(count: number): string {
	return `‹ +${count}`;
}

/** The trailing overflow marker for `count` hidden tabs ("+2 ›"). */
export function trailingOverflowLabel(count: number): string {
	return `+${count} ›`;
}

/** Columns the window [start, end) occupies, overflow markers and gaps included. */
export function windowColumns(
	widths: readonly number[],
	start: number,
	end: number,
	gap: number
): number {
	let total = 0;
	let items = 0;
	for (let index = start; index < end; index += 1) {
		total += widths[index] ?? 0;
		items += 1;
	}
	if (start > 0) {
		total += displayWidth(leadingOverflowLabel(start));
		items += 1;
	}
	if (end < widths.length) {
		total += displayWidth(trailingOverflowLabel(widths.length - end));
		items += 1;
	}
	return total + Math.max(0, items - 1) * gap;
}

/**
 * The slice [start, end) of chips that fits `budget` columns (chips separated by
 * `gap`, overflow markers counted). The active chip is always inside the window;
 * the window grows around it alternately right then left so it stays centred.
 */
export function visibleTabWindow(
	widths: readonly number[],
	activeIndex: number,
	budget: number,
	gap = 1
): { end: number; start: number } {
	const count = widths.length;
	if (count === 0) {
		return { start: 0, end: 0 };
	}
	if (windowColumns(widths, 0, count, gap) <= budget) {
		return { start: 0, end: count };
	}
	const active = Math.min(Math.max(activeIndex, 0), count - 1);
	let start = active;
	let end = active + 1;
	let preferRight = true;
	for (;;) {
		const canRight =
			end < count && windowColumns(widths, start, end + 1, gap) <= budget;
		const canLeft =
			start > 0 && windowColumns(widths, start - 1, end, gap) <= budget;
		if (!(canRight || canLeft)) {
			return { start, end };
		}
		if (canRight && (preferRight || !canLeft)) {
			end += 1;
		} else {
			start -= 1;
		}
		preferRight = !preferRight;
	}
}

/** Columns a full, unwindowed row of chips needs (`gap` between chips). */
export function tabRowWidth(widths: readonly number[], gap = 1): number {
	return windowColumns(widths, 0, widths.length, gap);
}

/**
 * Split `available` columns between pane groups that each need `needs[i]`
 * columns. A pane that fits its even share takes only what it needs and the
 * slack goes to the panes that would otherwise overflow, so a short pane never
 * strands columns its crowded neighbour could use.
 */
export function allocatePaneBudgets(
	needs: readonly number[],
	available: number
): number[] {
	const budgets = needs.map(() => 0);
	let remaining = Math.max(0, available);
	let open = needs.map((_, index) => index);
	while (open.length > 0) {
		const share = Math.floor(remaining / open.length);
		const fitting = open.filter((index) => (needs[index] ?? 0) <= share);
		if (fitting.length === 0) {
			for (const index of open) {
				budgets[index] = Math.max(1, share);
			}
			break;
		}
		for (const index of fitting) {
			budgets[index] = needs[index] ?? 0;
			remaining -= budgets[index] ?? 0;
		}
		open = open.filter((index) => !fitting.includes(index));
	}
	return budgets;
}
