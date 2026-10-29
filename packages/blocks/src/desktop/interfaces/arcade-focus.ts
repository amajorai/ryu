/**
 * Keyboard focus on the floor: the theme's ring, set off from the art by a
 * band of the theme background on both sides so it reads on any cabinet or
 * carpet, light or dark. `outline-solid` is explicit because Tailwind v4's
 * `outline-hidden` and `outline-2` share one style variable.
 */
export const ARCADE_FOCUS =
	"outline-hidden focus-visible:outline-solid focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:ring-6 focus-visible:ring-background";
