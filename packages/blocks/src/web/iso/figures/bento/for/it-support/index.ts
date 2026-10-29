import type { BentoDrawings } from "../../card.ts";
import { drawing as guidedTroubleshooting } from "./guided-troubleshooting.tsx";
import { drawing as knowledgeBaseAnswers } from "./knowledge-base-answers.tsx";
import { drawing as onboardingAndOffboarding } from "./onboarding-and-offboarding.tsx";
import { drawing as recurringHealthChecks } from "./recurring-health-checks.tsx";
import { drawing as runbookDrafting } from "./runbook-drafting.tsx";
import { drawing as ticketTriage } from "./ticket-triage.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Ticket triage": ticketTriage,
	"Guided troubleshooting": guidedTroubleshooting,
	"Knowledge base answers": knowledgeBaseAnswers,
	"Onboarding and offboarding": onboardingAndOffboarding,
	"Runbook drafting": runbookDrafting,
	"Recurring health checks": recurringHealthChecks,
};
