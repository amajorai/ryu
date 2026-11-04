/* Roving keyboard selection for the /pricing credit-plan radiogroup. The plan cards sit in a grid
   that mirrors under `dir="rtl"`, so ArrowLeft and ArrowRight swap there: the arrow always moves
   toward the card it points at. ArrowUp and ArrowDown keep reading order. */

/** The card index a key moves to from `index` among `count` cards, or `null` for other keys. */
export function creditPlanKeyTarget(
	key: string,
	index: number,
	count: number,
	direction: "ltr" | "rtl" = "ltr"
): number | null {
	if (count <= 0) {
		return null;
	}
	if (key === "Home") {
		return 0;
	}
	if (key === "End") {
		return count - 1;
	}
	const rtl = direction === "rtl";
	const forward =
		key === "ArrowDown" || key === (rtl ? "ArrowLeft" : "ArrowRight");
	const backward =
		key === "ArrowUp" || key === (rtl ? "ArrowRight" : "ArrowLeft");
	if (forward) {
		return (index + 1) % count;
	}
	if (backward) {
		return (index + count - 1) % count;
	}
	return null;
}
