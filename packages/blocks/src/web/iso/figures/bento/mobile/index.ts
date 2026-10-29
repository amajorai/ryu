import type { BentoDrawings } from "../card.ts";
import { drawing as picksTheBestServer } from "./picks-the-best-server.tsx";
import { drawing as sameAgents } from "./same-agents.tsx";
import { drawing as smallOpenModels } from "./small-open-models.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Small open models": smallOpenModels,
	"Picks the best server": picksTheBestServer,
	"Same agents": sameAgents,
};
