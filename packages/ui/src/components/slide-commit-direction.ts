/**
 * Reading-direction helpers for SlideCommit. The grip rests at the inline
 * start and travels toward the inline end, so under `dir="rtl"` it starts at
 * the physical right: pointer progress, arrow keys and the painted fill all
 * mirror.
 */

export type InlineDirection = "ltr" | "rtl";

/** `-1` when the track reads right-to-left, otherwise `1`. */
export function inlineSign(direction: InlineDirection | undefined): 1 | -1 {
	return direction === "rtl" ? -1 : 1;
}

/**
 * Distance of `clientX` from the track's inline start, scaled from the
 * track's painted width (which may be pulsing) to its laid-out width.
 */
export function progressFromPointer(
	clientX: number,
	track: Pick<Element, "getBoundingClientRect"> | null | undefined,
	measured: number,
	direction: InlineDirection | undefined
): number {
	const rect = track?.getBoundingClientRect();
	if (!rect?.width) {
		return 0;
	}
	const fromStart =
		direction === "rtl" ? rect.right - clientX : clientX - rect.left;
	return fromStart * (measured / rect.width);
}

/**
 * How a key moves the grip: `1` toward the inline end (commit), `-1` back
 * toward the start, `0` for keys it ignores. Up/Down keep their meaning in
 * either direction; Left/Right follow the reading direction.
 */
export function arrowDelta(
	key: string,
	direction: InlineDirection | undefined
): -1 | 0 | 1 {
	const sign = inlineSign(direction);
	switch (key) {
		case "ArrowUp":
			return 1;
		case "ArrowDown":
			return -1;
		case "ArrowRight":
			return sign;
		case "ArrowLeft":
			return sign === 1 ? -1 : 1;
		default:
			return 0;
	}
}

/** The fill clip that reveals the grip from the inline start to `edge` px. */
export function revealClip(
	edge: number,
	width: number,
	radius: number,
	direction: InlineDirection | undefined
): string {
	const hidden = width - edge;
	return direction === "rtl"
		? `inset(0 0 0 ${hidden}px round ${radius}px)`
		: `inset(0 ${hidden}px 0 0 round ${radius}px)`;
}

/** The scale origin at the grip's inline-start edge, `seen` px into the fill. */
export function gripOrigin(
	seen: number,
	width: number,
	direction: InlineDirection | undefined
): string {
	return `${direction === "rtl" ? width - seen : seen}px 50%`;
}
