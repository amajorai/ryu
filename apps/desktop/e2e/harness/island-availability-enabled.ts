// Island settings proof only: Island's release gate
// (`src/lib/island-availability.ts`) is off, which swaps the Island settings
// tab for an "unavailable" notice. This proof keeps the shipping-ready
// IslandSettings view covered by aliasing the gate on for its harness build.

/** Whether the Island companion ships in this release (forced on for the proof). */
export const ISLAND_ENABLED = true as boolean;

/** Same copy as the real gate module so dependents render unchanged. */
export const ISLAND_UNAVAILABLE_NOTE =
	"The Island companion that registers system-wide shortcuts is not available in this release.";
