import type { BentoDrawings } from "../card.ts";
import { drawing as anyStep } from "./any-step.tsx";
import { drawing as subAgentDelegation } from "./sub-agent-delegation.tsx";
import { drawing as triggersAndSchedules } from "./triggers-and-schedules.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Sub-agent delegation": subAgentDelegation,
	"Any step": anyStep,
	"Triggers and schedules": triggersAndSchedules,
};
