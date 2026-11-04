// Which side of a horizontal drop target the pointer is on, in reading order.
//
// Drag-reorder surfaces store the drop as "before" or "after" the hovered item
// in DOM (logical) order. Under a right-to-left layout the first item is drawn
// on the right, so the logical "before" half of an item is its right half: a
// physical left-half test would land the drop one slot past where it was
// aimed and disagree with the slide-apart preview.

export type ReadingDirection = "ltr" | "rtl";

/** The rendered reading direction of `element`; LTR outside a DOM. */
export function readingDirectionOf(
	element: Element | null | undefined
): ReadingDirection {
	if (!element || typeof getComputedStyle !== "function") {
		return "ltr";
	}
	return getComputedStyle(element).direction === "rtl" ? "rtl" : "ltr";
}

/**
 * Whether a pointer at `clientX` drops before the item drawn at `rect` in
 * logical order: its left half under LTR, its right half under RTL.
 */
export function pointerBefore(
	clientX: number,
	rect: { left: number; width: number },
	direction: ReadingDirection
): boolean {
	const middle = rect.left + rect.width / 2;
	return direction === "rtl" ? clientX > middle : clientX < middle;
}

/**
 * Whether the pointer drops before the item along `axis`: the reading-order
 * side of its middle for a horizontal list, the top half for a vertical one.
 */
export function pointerBeforeOnAxis(
	clientX: number,
	clientY: number,
	rect: { height: number; left: number; top: number; width: number },
	axis: "x" | "y",
	direction: ReadingDirection
): boolean {
	return axis === "x"
		? pointerBefore(clientX, rect, direction)
		: clientY < rect.top + rect.height / 2;
}
