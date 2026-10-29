import type { BentoDrawings } from "../../card.ts";
import { drawing as chronologyBuilding } from "./chronology-building.tsx";
import { drawing as citeAndQuoteChecking } from "./cite-and-quote-checking.tsx";
import { drawing as discoveryReviewAndIndexing } from "./discovery-review-and-indexing.tsx";
import { drawing as documentSummarization } from "./document-summarization.tsx";
import { drawing as filingAndExhibitPrep } from "./filing-and-exhibit-prep.tsx";
import { drawing as intakeAndMatterSetup } from "./intake-and-matter-setup.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Document summarization": documentSummarization,
	"Chronology building": chronologyBuilding,
	"Cite and quote checking": citeAndQuoteChecking,
	"Discovery review and indexing": discoveryReviewAndIndexing,
	"Filing and exhibit prep": filingAndExhibitPrep,
	"Intake and matter setup": intakeAndMatterSetup,
};
