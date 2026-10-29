import type { BentoDrawings } from "../../card.ts";
import { drawing as bankReconciliation } from "./bank-reconciliation.tsx";
import { drawing as clientQueryResponse } from "./client-query-response.tsx";
import { drawing as financialStatementDrafting } from "./financial-statement-drafting.tsx";
import { drawing as monthEndClose } from "./month-end-close.tsx";
import { drawing as transactionCategorization } from "./transaction-categorization.tsx";
import { drawing as varianceAnalysis } from "./variance-analysis.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Bank reconciliation": bankReconciliation,
	"Month-end close": monthEndClose,
	"Variance analysis": varianceAnalysis,
	"Financial statement drafting": financialStatementDrafting,
	"Transaction categorization": transactionCategorization,
	"Client query response": clientQueryResponse,
};
