export const MAX_THREAD_FACES = 3;

/**
 * Link ink: the theme's primary pulled toward the text color, so 12px links
 * clear AA contrast in light themes (a pale primary on white does not) while
 * still reading as the theme's link color.
 */
export const LINK_INK =
	"text-[color-mix(in_oklab,var(--primary)_68%,var(--foreground))]";

export const MARK_CLASS = "rounded-sm bg-warning/30 text-inherit";
