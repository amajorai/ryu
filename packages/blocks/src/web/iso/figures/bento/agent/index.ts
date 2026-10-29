import type { BentoDrawings } from "../card.ts";
import { drawing as adminAccess } from "./admin-access.tsx";
import { drawing as auditTrail } from "./audit-trail.tsx";
import { drawing as budgetsAndCost } from "./budgets-and-cost.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Budgets and cost": budgetsAndCost,
	"Audit trail": auditTrail,
	"Admin access": adminAccess,
};
