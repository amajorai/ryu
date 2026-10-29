import type { BentoDrawings } from "../../card.ts";
import { drawing as deliverableDrafting } from "./deliverable-drafting.tsx";
import { drawing as financialAndDataAnalysis } from "./financial-and-data-analysis.tsx";
import { drawing as interviewSynthesis } from "./interview-synthesis.tsx";
import { drawing as knowledgeRetrieval } from "./knowledge-retrieval.tsx";
import { drawing as marketAndCompetitorResearch } from "./market-and-competitor-research.tsx";
import { drawing as proposalAndSowDrafting } from "./proposal-and-sow-drafting.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Market and competitor research": marketAndCompetitorResearch,
	"Deliverable drafting": deliverableDrafting,
	"Interview synthesis": interviewSynthesis,
	"Financial and data analysis": financialAndDataAnalysis,
	"Proposal and SOW drafting": proposalAndSowDrafting,
	"Knowledge retrieval": knowledgeRetrieval,
};
