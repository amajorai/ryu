// Writing-direction helpers for the table resize controller. Pointer and arrow
// key deltas arrive in physical pixels (clientX grows to the right), while
// column widths, the stored start margin and the boundary indicators are all
// measured from the table's inline start. Under RTL the inline start is the
// physical right, so horizontal deltas flip sign and indicators are placed
// with `inset-inline-start`.

import type { TableResizeDirection } from "./table-node-resize-context.ts";

/** +1 when the inline axis runs left to right, -1 when it runs right to left. */
export type TableInlineSign = 1 | -1;

/** Read the element's computed writing direction as an inline sign. */
export function getTableInlineSign(
	element: Element | null | undefined
): TableInlineSign {
	if (!element || typeof getComputedStyle !== "function") {
		return 1;
	}

	return getComputedStyle(element).direction === "rtl" ? -1 : 1;
}

/**
 * Convert a physical pointer or arrow-key delta into an inline delta: a
 * column's inline-end edge moving away from its start (rightward in LTR,
 * leftward in RTL) widens it. Row resizing is vertical and never flips.
 */
export function toInlineResizeDelta(
	physicalDelta: number,
	direction: TableResizeDirection,
	inlineSign: TableInlineSign
): number {
	if (direction === "bottom") {
		return physicalDelta;
	}

	return physicalDelta * inlineSign;
}

/**
 * Offset of a resize handle's centre from the wrapper's inline start, given
 * both rects in viewport coordinates.
 */
export function getHandleInlineOffset(
	handleRect: Pick<DOMRect, "left" | "right" | "width">,
	wrapperRect: Pick<DOMRect, "left" | "right">,
	inlineSign: TableInlineSign
): number {
	const handleCentre = handleRect.left + handleRect.width / 2;

	return inlineSign === -1
		? wrapperRect.right - handleCentre
		: handleCentre - wrapperRect.left;
}
