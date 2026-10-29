import type { BentoDrawings } from "../../card.ts";
import { drawing as analysisPipelines } from "./analysis-pipelines.tsx";
import { drawing as dataExtraction } from "./data-extraction.tsx";
import { drawing as grantAndProposalSupport } from "./grant-and-proposal-support.tsx";
import { drawing as libraryQuestions } from "./library-questions.tsx";
import { drawing as literatureScreening } from "./literature-screening.tsx";
import { drawing as manuscriptDrafting } from "./manuscript-drafting.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Literature screening": literatureScreening,
	"Data extraction": dataExtraction,
	"Library questions": libraryQuestions,
	"Analysis pipelines": analysisPipelines,
	"Manuscript drafting": manuscriptDrafting,
	"Grant and proposal support": grantAndProposalSupport,
};
