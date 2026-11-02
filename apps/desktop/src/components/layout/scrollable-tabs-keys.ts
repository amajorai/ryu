/**
 * The card index an arrow key moves to. The card row follows the reading
 * direction, so under RTL ArrowLeft moves to the next card.
 */
export function cardIndexForKey(
	key: string,
	index: number,
	direction: "ltr" | "rtl" = "ltr"
): number | undefined {
	if (key !== "ArrowLeft" && key !== "ArrowRight") {
		return;
	}
	const nextKey = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
	return index + (key === nextKey ? 1 : -1);
}

/**
 * How far a vertical wheel delta scrolls the card row. Under RTL `scrollLeft`
 * runs from zero toward negative values, so the delta flips to keep scrolling
 * down moving toward the inline end.
 */
export function inlineWheelDelta(
	deltaY: number,
	direction: "ltr" | "rtl" = "ltr"
): number {
	return direction === "rtl" ? -deltaY : deltaY;
}
