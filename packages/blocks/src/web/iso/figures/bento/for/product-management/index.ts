import type { BentoDrawings } from "../../card.ts";
import { drawing as backlogGrooming } from "./backlog-grooming.tsx";
import { drawing as competitiveScans } from "./competitive-scans.tsx";
import { drawing as feedbackSynthesis } from "./feedback-synthesis.tsx";
import { drawing as releaseNotes } from "./release-notes.tsx";
import { drawing as specDrafting } from "./spec-drafting.tsx";
import { drawing as statusDigests } from "./status-digests.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Feedback synthesis": feedbackSynthesis,
	"Spec drafting": specDrafting,
	"Backlog grooming": backlogGrooming,
	"Release notes": releaseNotes,
	"Competitive scans": competitiveScans,
	"Status digests": statusDigests,
};
