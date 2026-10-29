import type { BentoDrawings } from "../card.ts";
import { drawing as agentInboxes } from "./agent-inboxes.tsx";
import { drawing as managedAiCredits } from "./managed-ai-credits.tsx";
import { drawing as yourKeysOrLocalModels } from "./your-keys-or-local-models.tsx";
import { drawing as yourOwnCloudComputer } from "./your-own-cloud-computer.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Your own cloud computer": yourOwnCloudComputer,
	"Managed AI credits": managedAiCredits,
	"Your keys or local models": yourKeysOrLocalModels,
	"Agent inboxes": agentInboxes,
};
