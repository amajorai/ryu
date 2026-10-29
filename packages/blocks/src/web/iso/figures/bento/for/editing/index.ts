import type { BentoDrawings } from "../../card.ts";
import { drawing as consistencyAudit } from "./consistency-audit.tsx";
import { drawing as factAndReferenceCheck } from "./fact-and-reference-check.tsx";
import { drawing as grammarAndSpellingPass } from "./grammar-and-spelling-pass.tsx";
import { drawing as lineEditSuggestions } from "./line-edit-suggestions.tsx";
import { drawing as prePublishQaWorkflow } from "./pre-publish-qa-workflow.tsx";
import { drawing as styleGuideEnforcement } from "./style-guide-enforcement.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Grammar and spelling pass": grammarAndSpellingPass,
	"Style guide enforcement": styleGuideEnforcement,
	"Consistency audit": consistencyAudit,
	"Line edit suggestions": lineEditSuggestions,
	"Fact and reference check": factAndReferenceCheck,
	"Pre-publish QA workflow": prePublishQaWorkflow,
};
