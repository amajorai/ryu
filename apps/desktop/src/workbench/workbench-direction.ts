/**
 * Reading-direction helpers for the workbench grid. The grid mirrors under
 * RTL: the persisted `left` region (grid column 1, the inline start) sits on
 * the physical right of the screen and `right` on the physical left. Region
 * ids never change; only the resize sign and the words that name a region on
 * screen follow the direction.
 */

import type { BottomAlignment, WorkbenchRegion } from "@ryu/workbench/model";

export type WorkbenchDirection = "ltr" | "rtl";

type ResizableRegion = Exclude<WorkbenchRegion, "center">;

/**
 * The sign that turns a physical pointer or arrow-key movement into a size
 * change: +1 when moving the separator toward screen-right (or down) grows
 * the region, -1 when it shrinks it.
 */
export function regionDeltaSign(
	region: ResizableRegion,
	dir: WorkbenchDirection
): 1 | -1 {
	if (region === "bottom") {
		return -1;
	}
	const growsRightward = region === "left";
	const mirrored = dir === "rtl";
	return growsRightward === mirrored ? -1 : 1;
}

/** Size delta of a pointer drag from `start` to `current` client coordinates. */
export function regionPointerDelta(
	region: ResizableRegion,
	dir: WorkbenchDirection,
	start: { x: number; y: number },
	current: { x: number; y: number }
): number {
	const movement =
		region === "bottom" ? current.y - start.y : current.x - start.x;
	return regionDeltaSign(region, dir) * movement;
}

/**
 * The physical side a persisted side id appears on. Under RTL `left` is drawn
 * on the right, so "Left" in the UI always names the region on screen-left.
 */
export function physicalSide<Side extends WorkbenchRegion | BottomAlignment>(
	side: Side,
	dir: WorkbenchDirection
): Side {
	if (dir !== "rtl") {
		return side;
	}
	if (side === "left") {
		return "right" as Side;
	}
	if (side === "right") {
		return "left" as Side;
	}
	return side;
}
