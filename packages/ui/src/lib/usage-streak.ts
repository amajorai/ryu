// Shared copy for the profile usage streak, so every surface (desktop Stats,
// web settings, the public profile, Wrapped) defines a "streak day" the same
// way. The control plane counts a UTC day as active when the account used Ryu
// that day, including agent runs it started on a schedule; the built-in
// health check bot does not count.

/** Full explanation, for tooltips and screen-reader descriptions. */
export const USAGE_STREAK_HINT =
	"Days in a row you used Ryu (UTC). Agent runs count too, so a scheduled agent can keep your streak going.";

/** Compact variant for tight layouts (cards, share images). */
export const USAGE_STREAK_HINT_SHORT =
	"UTC days in a row; agent runs keep it going";
