// apps/desktop/src/components/layout/sidebar-group-avatar.ts
//
// Cell placement for the stacked group avatar on a sidebar conversation row.
//
// The layout must follow BOTH the members that resolved to an agent and whether a
// "+N" overflow cell is drawn. The overflow cell always sits bottom-right, so any
// layout that is not the four-corner grid would overlap it: a single resolved
// member in a five-person group must take the top-left corner, not the centre.

const CENTRED = ["left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"];
const SIDE_BY_SIDE = [
	"left-0 top-1/2 -translate-y-1/2",
	"right-0 top-1/2 -translate-y-1/2",
];
const CORNERS = [
	"left-0 top-0",
	"right-0 top-0",
	"bottom-0 left-0",
	"right-0 bottom-0",
];

/** Position classes for each shown avatar cell, in render order. */
export function groupAvatarPositions(
	shownCount: number,
	hiddenCount: number
): string[] {
	if (hiddenCount === 0 && shownCount === 1) {
		return CENTRED;
	}
	if (hiddenCount === 0 && shownCount === 2) {
		return SIDE_BY_SIDE;
	}
	return CORNERS;
}
