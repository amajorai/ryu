import type { BentoDrawings } from "../card.ts";
import { drawing as chooseASpecialist } from "./choose-a-specialist.tsx";
import { drawing as keepTheRecord } from "./keep-the-record.tsx";
import { drawing as reviewTheRequest } from "./review-the-request.tsx";
import { drawing as runOnce } from "./run-once.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Choose a specialist": chooseASpecialist,
	"Review the request": reviewTheRequest,
	"Run once": runOnce,
	"Keep the record": keepTheRecord,
};
