import type { BentoDrawings } from "../../card.ts";
import { drawing as accessibilityAudit } from "./accessibility-audit.tsx";
import { drawing as conceptGeneration } from "./concept-generation.tsx";
import { drawing as designCritique } from "./design-critique.tsx";
import { drawing as designToFrontEnd } from "./design-to-front-end.tsx";
import { drawing as researchSynthesis } from "./research-synthesis.tsx";
import { drawing as uxCopywriting } from "./ux-copywriting.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Concept generation": conceptGeneration,
	"UX copywriting": uxCopywriting,
	"Accessibility audit": accessibilityAudit,
	"Design to front-end": designToFrontEnd,
	"Design critique": designCritique,
	"Research synthesis": researchSynthesis,
};
