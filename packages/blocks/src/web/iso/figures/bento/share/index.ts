import type { BentoDrawings } from "../card.ts";
import { drawing as idleOnly } from "./idle-only.tsx";
import { drawing as paidByUsage } from "./paid-by-usage.tsx";
import { drawing as yourSchedule } from "./your-schedule.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Your schedule": yourSchedule,
	"Idle only": idleOnly,
	"Paid by usage": paidByUsage,
};
