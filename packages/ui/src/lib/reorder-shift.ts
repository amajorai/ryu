// Sortable-list geometry for drag reordering.
//
// Instead of drawing a drop line, a reorder surface slides the items between
// the dragged item and its destination out of the way by the dragged item's
// pitch (its size plus the gap after it), and glides the dragged item itself
// into the space that opens. Only transforms move, so layout — and therefore
// every hit test against the untransformed slots — stays put, and committing
// the drop lands each item exactly where it is already drawn.

/** One rendered item along the list axis, measured before any shift. */
export interface ReorderSlot {
	end: number;
	id: string;
	start: number;
}

/**
 * Index the dragged item lands on once it is removed and re-inserted.
 * `before` says which side of the target it goes; omit it for "take the
 * target's slot" lists (insert after when dragging forward, before when
 * dragging back).
 */
export function reorderDestination(
	from: number,
	target: number,
	before?: boolean
): number {
	const insertBefore = before ?? from > target;
	const insertAt = insertBefore ? target : target + 1;
	return insertAt > from ? insertAt - 1 : insertAt;
}

/**
 * Per-item offsets (px along the axis) that preview `activeId` moving next to
 * `overId`. `slots` must be in visual order. Items that do not move are left
 * out of the map.
 */
export function computeReorderShifts(
	slots: readonly ReorderSlot[],
	activeId: string | null,
	overId: string | null,
	before?: boolean
): Map<string, number> {
	const shifts = new Map<string, number>();
	if (!(activeId && overId) || activeId === overId) {
		return shifts;
	}
	const from = slots.findIndex((slot) => slot.id === activeId);
	const target = slots.findIndex((slot) => slot.id === overId);
	if (from < 0 || target < 0) {
		return shifts;
	}
	const to = reorderDestination(from, target, before);
	const source = slots[from];
	const landing = slots[to];
	if (to === from || !(source && landing)) {
		return shifts;
	}
	if (to > from) {
		// Moving forward: everything it passes steps back by its pitch.
		const next = slots[from + 1];
		const pitch = next ? next.start - source.start : 0;
		for (let index = from + 1; index <= to; index++) {
			const slot = slots[index];
			if (slot) {
				shifts.set(slot.id, -pitch);
			}
		}
		shifts.set(source.id, landing.end - source.end);
		return shifts;
	}
	// Moving back: everything it passes steps forward by its pitch.
	const previous = slots[from - 1];
	const pitch = previous ? source.end - previous.end : 0;
	for (let index = to; index < from; index++) {
		const slot = slots[index];
		if (slot) {
			shifts.set(slot.id, pitch);
		}
	}
	shifts.set(source.id, landing.start - source.start);
	return shifts;
}
