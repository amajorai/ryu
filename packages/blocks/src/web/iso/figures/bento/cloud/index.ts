import type { BentoDrawings } from "../card.ts";
import { drawing as euOrSingapore } from "./eu-or-singapore.tsx";
import { drawing as gatewayRulesApply } from "./gateway-rules-apply.tsx";
import { drawing as managedNodeIncluded } from "./managed-node-included.tsx";
import { drawing as yoursToMove } from "./yours-to-move.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Managed node included": managedNodeIncluded,
	"Gateway rules apply": gatewayRulesApply,
	"EU or Singapore": euOrSingapore,
	"Yours to move": yoursToMove,
};
