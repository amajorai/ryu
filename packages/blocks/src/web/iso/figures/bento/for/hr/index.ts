import type { BentoDrawings } from "../../card.ts";
import { drawing as complianceReminders } from "./compliance-reminders.tsx";
import { drawing as documentDrafting } from "./document-drafting.tsx";
import { drawing as engagementSurveyAnalysis } from "./engagement-survey-analysis.tsx";
import { drawing as jobDescriptionWriting } from "./job-description-writing.tsx";
import { drawing as onboardingPrep } from "./onboarding-prep.tsx";
import { drawing as policyQuestions } from "./policy-questions.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Policy questions": policyQuestions,
	"Document drafting": documentDrafting,
	"Onboarding prep": onboardingPrep,
	"Job description writing": jobDescriptionWriting,
	"Engagement survey analysis": engagementSurveyAnalysis,
	"Compliance reminders": complianceReminders,
};
