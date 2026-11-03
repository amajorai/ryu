/**
 * Reading-direction helpers for the workspace dock. The dock sits on the
 * inline-end edge (physical right under LTR, physical left under RTL), so the
 * off-screen hide transform and the horizontal resize delta both mirror.
 */

export type DockDirection = "ltr" | "rtl";

export type DockHideTransform = "translateX(100%)" | "translateX(-100%)";

/** Off-screen transform that slides the dock past its inline-end edge. */
export function dockHideTransform(dir: DockDirection): DockHideTransform {
	return dir === "rtl" ? "translateX(-100%)" : "translateX(100%)";
}

/**
 * How much a drag grows the dock. Vertical docks grow when dragged up; the
 * inline-end dock grows when dragged toward the inline start (left under LTR,
 * right under RTL).
 */
export function dockResizeDelta(
	axis: "vertical" | "horizontal",
	dir: DockDirection,
	startPos: number,
	pos: number
): number {
	const delta = startPos - pos;
	return axis === "horizontal" && dir === "rtl" ? -delta : delta;
}
