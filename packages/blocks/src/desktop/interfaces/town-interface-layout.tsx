/** The docked City Hall desk's width, and the HUD's gutter. */
export const DESK_WIDTH = 340;
export const GUTTER = 16;
/**
 * The desk never docks: it folds into the City Hall plate (petitions count)
 * and opens over the town on demand, so the town fills the frame.
 */
export const DESK_DOCKS_AT = Number.POSITIVE_INFINITY;

/**
 * While the scene loads: the island's outline, the way the diorama will sit,
 * in the theme's muted tone and pulsing like the other skeletons.
 */
export function IslandPlaceholder() {
	return (
		<svg
			aria-hidden="true"
			className="aspect-[2/1.3] w-full max-w-3xl animate-pulse text-(--gk-plate) motion-reduce:animate-none"
			focusable="false"
			viewBox="0 0 200 130"
		>
			<path
				className="fill-current stroke-(--gk-edge) opacity-40"
				d="M100 4 L196 60 L100 116 L4 60 Z"
				strokeWidth={1}
				vectorEffect="non-scaling-stroke"
			/>
			<path
				className="fill-current stroke-(--gk-edge) opacity-60"
				d="M4 60 L100 116 L196 60 L196 70 L100 126 L4 70 Z"
				strokeWidth={1}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

/** Escape inside a text field belongs to the field. */
export function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	return (
		!target.isContentEditable &&
		target.closest("input, textarea, select, [contenteditable='true']") === null
	);
}
/** The status lines a minimal overlay density leaves off (limit and cue stay). */
export const MINIMAL_DROPS = ["elapsed:", "next:", "progress:"] as const;

/** The speed setting's values on the HUD's speed control. */
export const SPEED_OF = { fast: 3, normal: 1, paused: 0 } as const;

/** The speed setting for a speed control value. */
export function speedName(speed: number): keyof typeof SPEED_OF {
	if (speed === 0) {
		return "paused";
	}
	return speed > 1 ? "fast" : "normal";
}
