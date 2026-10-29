/**
 * Which shell `CommandDialog` renders, latched while the palette is open.
 *
 * `useIsMobile()` flips when a phone rotates or a window is resized past the
 * breakpoint. Swapping Dialog for Drawer mid-session remounts the palette's
 * children, which drops cmdk's search query and scroll position, so the
 * variant only follows the viewport while the palette is closed (and on the
 * render that opens it).
 */
export interface CommandVariantLatch {
	mobile: boolean;
	open: boolean;
}

/** The variant to render now: the latched one while it stays open. */
export function resolveCommandVariant(
	latch: CommandVariantLatch,
	open: boolean,
	isMobile: boolean
): boolean {
	return open && latch.open ? latch.mobile : isMobile;
}

/** The latch to store after this render, or `latch` itself when unchanged. */
export function nextCommandVariantLatch(
	latch: CommandVariantLatch,
	open: boolean,
	isMobile: boolean
): CommandVariantLatch {
	const mobile = resolveCommandVariant(latch, open, isMobile);
	if (latch.open === open && latch.mobile === mobile) {
		return latch;
	}
	return { mobile, open };
}
