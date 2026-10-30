import { ARENA_NAV_ATTRIBUTE } from "./arena-card.tsx";

export const CARD_SELECTOR = "article[data-agent-id]";
export const SCROLLER_ATTRIBUTE = "data-arena-scroller";
export const STICKY_ATTRIBUTE = "data-arena-sticky";
/** Breathing room kept around a revealed card (its selection ring sits outside it). */
const REVEAL_GAP_PX = 12;

/**
 * Scroll the wall just enough to show a card below the sticky filter row.
 * `scrollIntoView` ignores the sticky row, which would hide the card's top.
 */
export function revealCard(card: Element, scroller: HTMLElement) {
	const sticky = scroller.querySelector<HTMLElement>(`[${STICKY_ATTRIBUTE}]`);
	const view = scroller.getBoundingClientRect();
	const rect = card.getBoundingClientRect();
	const top = view.top + (sticky?.offsetHeight ?? 0) + REVEAL_GAP_PX;
	const bottom = view.bottom - REVEAL_GAP_PX;
	if (rect.top < top) {
		scroller.scrollBy({ top: rect.top - top });
	} else if (rect.bottom > bottom) {
		scroller.scrollBy({ top: Math.min(rect.bottom - bottom, rect.top - top) });
	}
}

/** How many grid columns the wall is showing right now. */
function columnCount(grid: HTMLElement): number {
	const template = getComputedStyle(grid).gridTemplateColumns;
	return Math.max(1, template.split(" ").filter(Boolean).length);
}

/** A card's primary action (Open/Close, or Message for a brand-new agent). */
export function navTarget(card: Element | null): HTMLElement | null {
	return (
		card?.querySelector<HTMLElement>(`[${ARENA_NAV_ATTRIBUTE}]`) ??
		card?.querySelector<HTMLElement>("button:not(:disabled)") ??
		null
	);
}

/**
 * Move focus between cards from any control inside one: left/right to the
 * previous/next card, up/down a whole row, Home/End to the first/last card.
 * Focus lands on the target card's primary action.
 */
export function moveFocus(
	grid: HTMLElement,
	from: HTMLElement,
	key: string
): boolean {
	const cards = [...grid.querySelectorAll<HTMLElement>(CARD_SELECTOR)];
	const index = cards.indexOf(from.closest<HTMLElement>(CARD_SELECTOR) ?? from);
	if (index === -1) {
		return false;
	}
	const step: Record<string, number> = {
		ArrowDown: columnCount(grid),
		ArrowLeft: -1,
		ArrowRight: 1,
		ArrowUp: -columnCount(grid),
		End: cards.length - 1 - index,
		Home: -index,
	};
	const delta = step[key];
	if (delta === undefined) {
		return false;
	}
	const next = cards[Math.min(cards.length - 1, Math.max(0, index + delta))];
	navTarget(next ?? null)?.focus();
	return true;
}

/** Escape inside a text field belongs to the field (or the host's composer). */
export function isEditable(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

/** Where the user opened the open thread from, so focus can go back there. */
export interface Opener {
	agentId: string | null;
	threadId: string | null;
}

export interface FocusRequest {
	at: number;
	to: "opener" | "panel";
}
