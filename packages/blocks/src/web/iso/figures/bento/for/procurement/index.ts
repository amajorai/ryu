import type { BentoDrawings } from "../../card.ts";
import { drawing as contractTermReview } from "./contract-term-review.tsx";
import { drawing as quoteComparison } from "./quote-comparison.tsx";
import { drawing as renewalTracking } from "./renewal-tracking.tsx";
import { drawing as rfpDraftingAndScoring } from "./rfp-drafting-and-scoring.tsx";
import { drawing as spendAnalysis } from "./spend-analysis.tsx";
import { drawing as vendorResearchAndDiligence } from "./vendor-research-and-diligence.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Quote comparison": quoteComparison,
	"Contract term review": contractTermReview,
	"Vendor research and diligence": vendorResearchAndDiligence,
	"Spend analysis": spendAnalysis,
	"RFP drafting and scoring": rfpDraftingAndScoring,
	"Renewal tracking": renewalTracking,
};
