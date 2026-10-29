import type { BentoDrawings } from "../../card.ts";
import { drawing as accountHealthChecks } from "./account-health-checks.tsx";
import { drawing as callPrepAndRecaps } from "./call-prep-and-recaps.tsx";
import { drawing as churnRiskFlagging } from "./churn-risk-flagging.tsx";
import { drawing as onboardingTracking } from "./onboarding-tracking.tsx";
import { drawing as qbrPrep } from "./qbr-prep.tsx";
import { drawing as renewalAndExpansionBriefs } from "./renewal-and-expansion-briefs.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Account health checks": accountHealthChecks,
	"Churn risk flagging": churnRiskFlagging,
	"QBR prep": qbrPrep,
	"Renewal and expansion briefs": renewalAndExpansionBriefs,
	"Onboarding tracking": onboardingTracking,
	"Call prep and recaps": callPrepAndRecaps,
};
