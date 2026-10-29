import type { BentoDrawings } from "../../card.ts";
import { drawing as buyerMatching } from "./buyer-matching.tsx";
import { drawing as comparativeMarketAnalysis } from "./comparative-market-analysis.tsx";
import { drawing as documentPrep } from "./document-prep.tsx";
import { drawing as leadFollowUp } from "./lead-follow-up.tsx";
import { drawing as listingCopy } from "./listing-copy.tsx";
import { drawing as showingCoordination } from "./showing-coordination.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Listing copy": listingCopy,
	"Lead follow-up": leadFollowUp,
	"Comparative market analysis": comparativeMarketAnalysis,
	"Showing coordination": showingCoordination,
	"Document prep": documentPrep,
	"Buyer matching": buyerMatching,
};
