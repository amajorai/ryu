/**
 * Index reached by an arrow/Home/End key in a horizontal tab list, if any. The
 * strip follows the reading direction, so under RTL ArrowLeft moves to the next
 * tab (toward the inline end) and ArrowRight to the previous one.
 */
export function tabIndexForKey(
	key: string,
	currentIndex: number,
	count: number,
	direction: "ltr" | "rtl" = "ltr"
): number | undefined {
	const nextKey = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
	const previousKey = direction === "rtl" ? "ArrowRight" : "ArrowLeft";
	switch (key) {
		case previousKey:
			return (currentIndex - 1 + count) % count;
		case nextKey:
			return (currentIndex + 1) % count;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return undefined;
	}
}
