import type { BentoDrawings } from "../../card.ts";
import { drawing as escalationSummaries } from "./escalation-summaries.tsx";
import { drawing as followUps } from "./follow-ups.tsx";
import { drawing as knowledgeBaseSearch } from "./knowledge-base-search.tsx";
import { drawing as macroAndArticleDrafting } from "./macro-and-article-drafting.tsx";
import { drawing as replyDrafting } from "./reply-drafting.tsx";
import { drawing as ticketTriageAndRouting } from "./ticket-triage-and-routing.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Reply drafting": replyDrafting,
	"Ticket triage and routing": ticketTriageAndRouting,
	"Knowledge base search": knowledgeBaseSearch,
	"Escalation summaries": escalationSummaries,
	"Macro and article drafting": macroAndArticleDrafting,
	"Follow-ups": followUps,
};
