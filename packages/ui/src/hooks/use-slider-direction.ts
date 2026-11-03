// Reading-direction helpers for `useSlider`. Under a right-to-left layout the
// slider's minimum sits at the inline start (the physical right edge), so a
// pointer near the right means "less" and ArrowLeft steps toward the end, the
// same way native range inputs and Base UI sliders behave.

export type SliderDirection = "ltr" | "rtl";

/**
 * Whether the element lays out right to left. The computed `direction` is the
 * source of truth, because it follows any `dir` attribute between the element
 * and the root. `fallback` (the `DirectionProvider` context) answers when there
 * is no element or no layout engine to ask.
 */
export function isRtlTrack(
	el: Element | null | undefined,
	fallback: SliderDirection = "ltr"
): boolean {
	if (el && typeof getComputedStyle === "function") {
		const direction = getComputedStyle(el).direction;
		if (direction === "rtl" || direction === "ltr") {
			return direction === "rtl";
		}
	}
	return fallback === "rtl";
}

interface TrackRect {
	left: number;
	right: number;
	width: number;
}

/**
 * Where along the track the pointer sits, from 0 at the inline start to 1 at
 * the inline end, clamped to the track.
 */
export function ratioFromPointer(
	rect: TrackRect,
	clientX: number,
	rtl: boolean
): number {
	if (!(rect.width > 0)) {
		return 0;
	}
	const offset = rtl ? rect.right - clientX : clientX - rect.left;
	return Math.min(1, Math.max(0, offset / rect.width));
}

/**
 * How many steps an arrow key moves the value: +1 toward the end, -1 toward
 * the start, 0 for any other key. ArrowRight/ArrowLeft follow the reading
 * direction; ArrowUp/ArrowDown always mean more/less.
 */
export function strideForKey(key: string, rtl: boolean): -1 | 0 | 1 {
	switch (key) {
		case "ArrowUp":
			return 1;
		case "ArrowDown":
			return -1;
		case "ArrowRight":
			return rtl ? -1 : 1;
		case "ArrowLeft":
			return rtl ? 1 : -1;
		default:
			return 0;
	}
}
