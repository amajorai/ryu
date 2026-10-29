import type { BentoDrawings } from "../../card.ts";
import { drawing as automatedReadouts } from "./automated-readouts.tsx";
import { drawing as cohortAndRetentionAnalysis } from "./cohort-and-retention-analysis.tsx";
import { drawing as experimentDesign } from "./experiment-design.tsx";
import { drawing as funnelAnalysis } from "./funnel-analysis.tsx";
import { drawing as lifecycleAndOnboardingEmails } from "./lifecycle-and-onboarding-emails.tsx";
import { drawing as variantGeneration } from "./variant-generation.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Experiment design": experimentDesign,
	"Variant generation": variantGeneration,
	"Funnel analysis": funnelAnalysis,
	"Automated readouts": automatedReadouts,
	"Lifecycle and onboarding emails": lifecycleAndOnboardingEmails,
	"Cohort and retention analysis": cohortAndRetentionAnalysis,
};
