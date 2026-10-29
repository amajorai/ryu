import type { BentoDrawings } from "../../card.ts";
import { drawing as accountResearch } from "./account-research.tsx";
import { drawing as callPrepAndRecaps } from "./call-prep-and-recaps.tsx";
import { drawing as crmHygiene } from "./crm-hygiene.tsx";
import { drawing as inboxTriage } from "./inbox-triage.tsx";
import { drawing as personalizedOutreach } from "./personalized-outreach.tsx";
import { drawing as proposalsAndQuotes } from "./proposals-and-quotes.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Account research": accountResearch,
	"Personalized outreach": personalizedOutreach,
	"Call prep and recaps": callPrepAndRecaps,
	"CRM hygiene": crmHygiene,
	"Inbox triage": inboxTriage,
	"Proposals and quotes": proposalsAndQuotes,
};
