import type { BentoDrawings } from "../../card.ts";
import { drawing as clientQuestionnaireAndFollowUp } from "./client-questionnaire-and-follow-up.tsx";
import { drawing as deductionAndCreditReview } from "./deduction-and-credit-review.tsx";
import { drawing as priorYearComparison } from "./prior-year-comparison.tsx";
import { drawing as returnPreparationSupport } from "./return-preparation-support.tsx";
import { drawing as sourceDocumentOrganization } from "./source-document-organization.tsx";
import { drawing as taxResearch } from "./tax-research.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Source document organization": sourceDocumentOrganization,
	"Return preparation support": returnPreparationSupport,
	"Tax research": taxResearch,
	"Deduction and credit review": deductionAndCreditReview,
	"Client questionnaire and follow-up": clientQuestionnaireAndFollowUp,
	"Prior-year comparison": priorYearComparison,
};
