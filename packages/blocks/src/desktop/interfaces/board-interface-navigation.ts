import { BOARD_CARD_ATTRIBUTE } from "./board-card.tsx";
import {
	BOARD_LANE_ATTRIBUTE,
	BOARD_LANE_SCROLL_ATTRIBUTE,
} from "./board-column.tsx";
import { BOARD_ROW_ATTRIBUTE } from "./board-list.tsx";

const LIST_STEP: Record<string, number> = {
	ArrowDown: 1,
	ArrowUp: -1,
	j: 1,
	k: -1,
};

export const NAV_HINT_ID = "board-nav-hint";
/** Slightly longer than the lanes' 200ms width transition. */
export const LANE_RESIZE_MS = 240;
/** The board's own padding (p-4), kept to the left of a lane scrolled to start. */
const LANE_INSET = 16;
const ARROW_STEP: Record<string, [column: number, row: number]> = {
	ArrowDown: [0, 1],
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
};

function cardAt(
	root: HTMLElement,
	column: number,
	row: number
): HTMLElement | null {
	return root.querySelector<HTMLElement>(
		`[${BOARD_CARD_ATTRIBUTE}][data-column="${column}"][data-row="${row}"]`
	);
}

function lastRowIn(root: HTMLElement, column: number): number {
	return (
		root.querySelectorAll(`[${BOARD_CARD_ATTRIBUTE}][data-column="${column}"]`)
			.length - 1
	);
}

/**
 * Move focus between cards with the arrow keys: up/down within a lane,
 * left/right to the nearest card in the next non-empty lane.
 */
export function moveFocus(
	root: HTMLElement,
	from: HTMLElement,
	key: string,
	columnCount: number
): boolean {
	const step = ARROW_STEP[key];
	if (!step) {
		return false;
	}
	const column = Number(from.dataset.column);
	const row = Number(from.dataset.row);
	if (step[1] !== 0) {
		focusAndReveal(root, cardAt(root, column, row + step[1]));
		return true;
	}
	for (
		let next = column + step[0];
		next >= 0 && next < columnCount;
		next += step[0]
	) {
		const last = lastRowIn(root, next);
		if (last >= 0) {
			focusAndReveal(root, cardAt(root, next, Math.min(row, last)));
			return true;
		}
	}
	return true;
}

export function focusCard(root: HTMLElement | null, threadId: string | null) {
	if (!(root && threadId)) {
		return;
	}
	const thread = `[data-thread-id="${CSS.escape(threadId)}"]`;
	const row = root.querySelector<HTMLElement>(
		`${thread} [${BOARD_ROW_ATTRIBUTE}]`
	);
	if (row) {
		focusRow(row);
		return;
	}
	focusAndReveal(
		root,
		root.querySelector<HTMLElement>(`${thread} [${BOARD_CARD_ATTRIBUTE}]`)
	);
}

/** Focus a list row and scroll it just into view below the sticky header. */
function focusRow(row: HTMLElement | null) {
	if (!row) {
		return;
	}
	row.focus({ preventScroll: true });
	row.closest("li")?.scrollIntoView({ block: "nearest" });
}

/** Move between list rows: arrows or J/K, plus Home and End. */
export function moveRow(
	root: HTMLElement,
	from: HTMLElement,
	key: string
): boolean {
	const rows = root.querySelectorAll<HTMLElement>(`[${BOARD_ROW_ATTRIBUTE}]`);
	const index = Number(from.dataset.index);
	let next: number | null = null;
	if (key === "Home") {
		next = 0;
	} else if (key === "End") {
		next = rows.length - 1;
	} else if (LIST_STEP[key] !== undefined) {
		next = Math.min(rows.length - 1, Math.max(0, index + LIST_STEP[key]));
	}
	if (next === null) {
		return false;
	}
	focusRow(rows[next] ?? null);
	return true;
}

/** Whether a key event comes from somewhere the user is typing. */
export function isTyping(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select, [contenteditable='true']") !==
				null)
	);
}

/** How far `inner` sits outside `outer`'s visible span (0 when inside). */
function overflowBy(
	inner: { end: number; start: number },
	outer: { end: number; start: number },
	inset: number
): number {
	if (inner.start < outer.start + inset) {
		return inner.start - outer.start - inset;
	}
	if (inner.end > outer.end - inset) {
		return Math.min(
			inner.end - outer.end + inset,
			inner.start - outer.start - inset
		);
	}
	return 0;
}

/**
 * Scroll offsets at which a lane sits flush at the board's start (its snap
 * points), clamped to the scrollable range.
 */
function laneStops(board: HTMLElement): number[] {
	const boardLeft = board.getBoundingClientRect().left;
	const max = board.scrollWidth - board.clientWidth;
	return Array.from(
		board.querySelectorAll<HTMLElement>(`[${BOARD_LANE_ATTRIBUTE}]`),
		(lane) => {
			const offset =
				lane.getBoundingClientRect().left -
				boardLeft +
				board.scrollLeft -
				LANE_INSET;
			return Math.min(max, Math.max(0, Math.round(offset)));
		}
	);
}

/**
 * The lane boundary to rest on: the first one at or past `desired` when
 * moving right, the last one at or before it when moving left.
 */
function stopFor(board: HTMLElement, desired: number, forward: boolean) {
	const stops = laneStops(board);
	if (forward) {
		return (
			stops.find((stop) => stop >= desired - 1) ??
			board.scrollWidth - board.clientWidth
		);
	}
	// A reversed copy rather than `findLast`, which the desktop's lib target lacks.
	return [...stops].reverse().find((stop) => stop <= desired + 1) ?? 0;
}

/** Lanes wholly or partly out of view on each side of the board. */
export interface LaneOverflow {
	end: number;
	start: number;
}

export const NO_OVERFLOW: LaneOverflow = { end: 0, start: 0 };

export function laneOverflow(board: HTMLElement): LaneOverflow {
	const boardRect = board.getBoundingClientRect();
	let start = 0;
	let end = 0;
	for (const lane of board.querySelectorAll<HTMLElement>(
		`[${BOARD_LANE_ATTRIBUTE}]`
	)) {
		const rect = lane.getBoundingClientRect();
		if (rect.left < boardRect.left - 1) {
			start += 1;
		} else if (rect.right > boardRect.right + 1) {
			end += 1;
		}
	}
	return { end, start };
}

/** Scroll the board one lane boundary toward `forward`. */
export function stepLanes(board: HTMLElement, forward: boolean) {
	const stops = laneStops(board);
	const current = board.scrollLeft;
	const target = forward
		? (stops.find((stop) => stop > current + 1) ??
			board.scrollWidth - board.clientWidth)
		: ([...stops].reverse().find((stop) => stop < current - 1) ?? 0);
	board.scrollTo({ left: target });
}

/**
 * Bring a card into view by scrolling only the board and its lane — never the
 * page around them, which `scrollIntoView` would also shift. The board always
 * rests on a lane boundary, so no neighbour is left cut off mid-word.
 */
export function revealCard(board: HTMLElement, card: HTMLElement) {
	const lane = card.closest<HTMLElement>(`[${BOARD_LANE_ATTRIBUTE}]`) ?? card;
	const boardRect = board.getBoundingClientRect();
	const laneRect = lane.getBoundingClientRect();
	const nearest = overflowBy(
		{ end: laneRect.right, start: laneRect.left },
		{ end: boardRect.right, start: boardRect.left },
		LANE_INSET
	);
	if (nearest !== 0) {
		// Move only as far as needed, so earlier lanes stay in view whenever
		// the card allows it.
		const target = stopFor(board, board.scrollLeft + nearest, nearest > 0);
		board.scrollTo({ left: target });
	}
	const scroller = card.closest<HTMLElement>(
		`[${BOARD_LANE_SCROLL_ATTRIBUTE}]`
	);
	if (!scroller) {
		return;
	}
	const cardRect = card.getBoundingClientRect();
	const scrollerRect = scroller.getBoundingClientRect();
	const top = overflowBy(
		{ end: cardRect.bottom, start: cardRect.top },
		{ end: scrollerRect.bottom, start: scrollerRect.top },
		8
	);
	if (top !== 0) {
		scroller.scrollTo({ top: scroller.scrollTop + top });
	}
}

/** Focus a card's button without letting the browser scroll the page. */
function focusAndReveal(root: HTMLElement, button: HTMLElement | null) {
	if (!button) {
		return;
	}
	button.focus({ preventScroll: true });
	const card = button.closest<HTMLElement>("[data-thread-id]");
	if (card) {
		revealCard(root, card);
	}
}
