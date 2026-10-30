export type CursorStep = "first" | "last" | "next" | "previous";

/**
 * Keys that move the cursor. J/K work anywhere in the inbox; arrows and
 * Home/End only on a row, so they keep scrolling the conversation elsewhere.
 */
export function cursorStep(key: string, onRow: boolean): CursorStep | null {
	switch (key) {
		case "j":
			return "next";
		case "k":
			return "previous";
		case "ArrowDown":
			return onRow ? "next" : null;
		case "ArrowUp":
			return onRow ? "previous" : null;
		case "Home":
			return onRow ? "first" : null;
		case "End":
			return onRow ? "last" : null;
		default:
			return null;
	}
}

export function stepIndex(
	step: CursorStep,
	index: number,
	length: number
): number {
	switch (step) {
		case "first":
			return 0;
		case "last":
			return length - 1;
		case "next":
			return Math.min(index + 1, length - 1);
		default:
			return Math.max(index - 1, 0);
	}
}

/** Widgets inside the host's chat that own their own letter/arrow keys. */
export const KEY_OWNING_WIDGETS =
	'[role="menu"],[role="menubar"],[role="listbox"],[role="combobox"],[role="dialog"],[role="tablist"],[role="radiogroup"],[role="slider"],[role="grid"],[role="tree"]';

/** True when the key event started inside the host's chat surface. */
export function inHostChat(target: EventTarget): boolean {
	return (
		target instanceof Element && target.closest("[data-inbox-host]") !== null
	);
}

/** The inbox row a key event started on, if any. */
export function rowIdOf(target: EventTarget): string | undefined {
	return target instanceof HTMLElement ? target.dataset.inboxRow : undefined;
}
