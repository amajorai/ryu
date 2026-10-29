import type { BentoDrawings } from "../card.ts";
import { drawing as noRawTokens } from "./no-raw-tokens.tsx";
import { drawing as riskyActionsAsk } from "./risky-actions-ask.tsx";
import { drawing as scopedActions } from "./scoped-actions.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Risky actions ask": riskyActionsAsk,
	"No raw tokens": noRawTokens,
	"Scoped actions": scopedActions,
};
