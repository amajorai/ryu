import type { BentoDrawings } from "../../card.ts";
import { drawing as campaignPlanning } from "./campaign-planning.tsx";
import { drawing as competitorAndTrendResearch } from "./competitor-and-trend-research.tsx";
import { drawing as onePostManyFormats } from "./one-post-many-formats.tsx";
import { drawing as performanceRecaps } from "./performance-recaps.tsx";
import { drawing as repurposingLongForm } from "./repurposing-long-form.tsx";
import { drawing as socialScheduling } from "./social-scheduling.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Campaign planning": campaignPlanning,
	"One post, many formats": onePostManyFormats,
	"Social scheduling": socialScheduling,
	"Competitor and trend research": competitorAndTrendResearch,
	"Performance recaps": performanceRecaps,
	"Repurposing long-form": repurposingLongForm,
};
