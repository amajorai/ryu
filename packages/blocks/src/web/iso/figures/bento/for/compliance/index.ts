import type { BentoDrawings } from "../../card.ts";
import { drawing as auditAndQuestionnaireResponse } from "./audit-and-questionnaire-response.tsx";
import { drawing as evidenceAndControlReview } from "./evidence-and-control-review.tsx";
import { drawing as incidentAndFindingTriage } from "./incident-and-finding-triage.tsx";
import { drawing as obligationMonitoring } from "./obligation-monitoring.tsx";
import { drawing as policyReviewAndDrafting } from "./policy-review-and-drafting.tsx";
import { drawing as regulationToControlMapping } from "./regulation-to-control-mapping.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Regulation-to-control mapping": regulationToControlMapping,
	"Policy review and drafting": policyReviewAndDrafting,
	"Evidence and control review": evidenceAndControlReview,
	"Obligation monitoring": obligationMonitoring,
	"Audit and questionnaire response": auditAndQuestionnaireResponse,
	"Incident and finding triage": incidentAndFindingTriage,
};
