/** Escape inside a text field belongs to the field (or the host's composer). */
export function isEditable(target: EventTarget): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select, [contenteditable='true']") !==
				null)
	);
}

/** A focus move the lobby asked for, kept briefly while the host responds. */
export const FOCUS_REQUEST_TTL_MS = 2000;

/** Below this stage width the HUD plates go compact. */
export const COMPACT_BELOW = 760;

/** The island's rim round the plaza, for the woods and the shore. */
export const ISLAND_RIM = 3;
/** World units kept round the plates when the act layer frames the plaza. */
export const LOBBY_ACT_PLATE_FIT = {
	above: 1.8,
	below: 1.4,
	max: 2.6,
	side: 1.2,
};
/** Room round the ready-check pad's farthest slot. */
export const YOU_SPOT_ROOM = 0.6;
