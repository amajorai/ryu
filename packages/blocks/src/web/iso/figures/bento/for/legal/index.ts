import type { BentoDrawings } from "../../card.ts";
import { drawing as contractReview } from "./contract-review.tsx";
import { drawing as dueDiligence } from "./due-diligence.tsx";
import { drawing as firstPassDrafting } from "./first-pass-drafting.tsx";
import { drawing as matterIntake } from "./matter-intake.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Contract review": contractReview,
	"First-pass drafting": firstPassDrafting,
	"Due diligence": dueDiligence,
	"Matter intake": matterIntake,
};
