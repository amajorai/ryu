import type { TrackingStage } from "./tracking-model.ts";

/** Index of the step the parcel is on (or last reached) for each stage. */
export const STAGE_STEP: Record<TrackingStage, number> = {
	awaiting: 1,
	delivered: 4,
	// A failed run stops the parcel mid-route, where the courier was carrying it.
	exception: 2,
	label: 0,
	out: 3,
	transit: 2,
};

/** True when the courier is moving the parcel right now. */
export function isMoving(stage: TrackingStage): boolean {
	return stage === "transit" || stage === "out";
}
