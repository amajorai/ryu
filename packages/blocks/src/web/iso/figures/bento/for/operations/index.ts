import type { BentoDrawings } from "../../card.ts";
import { drawing as dataEntryAndReconciliation } from "./data-entry-and-reconciliation.tsx";
import { drawing as inboxAndTicketRouting } from "./inbox-and-ticket-routing.tsx";
import { drawing as onboardingAndOffboardingRunbooks } from "./onboarding-and-offboarding-runbooks.tsx";
import { drawing as recurringReportGeneration } from "./recurring-report-generation.tsx";
import { drawing as sopDraftingAndUpkeep } from "./sop-drafting-and-upkeep.tsx";
import { drawing as vendorAndInvoiceProcessing } from "./vendor-and-invoice-processing.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Recurring report generation": recurringReportGeneration,
	"Data entry and reconciliation": dataEntryAndReconciliation,
	"Vendor and invoice processing": vendorAndInvoiceProcessing,
	"Onboarding and offboarding runbooks": onboardingAndOffboardingRunbooks,
	"SOP drafting and upkeep": sopDraftingAndUpkeep,
	"Inbox and ticket routing": inboxAndTicketRouting,
};
