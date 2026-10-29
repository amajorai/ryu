import type { BentoDrawings } from "../../card.ts";
import { drawing as claimIntakeAndTriage } from "./claim-intake-and-triage.tsx";
import { drawing as coverageChecking } from "./coverage-checking.tsx";
import { drawing as documentSummarization } from "./document-summarization.tsx";
import { drawing as fraudSignalFlagging } from "./fraud-signal-flagging.tsx";
import { drawing as policyholderCorrespondence } from "./policyholder-correspondence.tsx";
import { drawing as underwritingSupport } from "./underwriting-support.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Claim intake and triage": claimIntakeAndTriage,
	"Coverage checking": coverageChecking,
	"Document summarization": documentSummarization,
	"Underwriting support": underwritingSupport,
	"Fraud signal flagging": fraudSignalFlagging,
	"Policyholder correspondence": policyholderCorrespondence,
};
