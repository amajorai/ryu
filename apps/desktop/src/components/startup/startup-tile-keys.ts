/** Tile step for an arrow key; the row follows the reading direction (RTL flips). */
export function tileDelta(key: string, direction: "ltr" | "rtl" = "ltr") {
	const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
	return direction === "rtl" && step !== 0 ? -step : step;
}
