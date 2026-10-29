import type { BentoDrawings } from "../../card.ts";
import { drawing as exceptionReporting } from "./exception-reporting.tsx";
import { drawing as multiClientBatchProcessing } from "./multi-client-batch-processing.tsx";
import { drawing as receiptAndInvoiceChasing } from "./receipt-and-invoice-chasing.tsx";
import { drawing as recurringJournalEntries } from "./recurring-journal-entries.tsx";
import { drawing as recurringReconciliation } from "./recurring-reconciliation.tsx";
import { drawing as transactionCategorization } from "./transaction-categorization.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Transaction categorization": transactionCategorization,
	"Recurring reconciliation": recurringReconciliation,
	"Receipt and invoice chasing": receiptAndInvoiceChasing,
	"Multi-client batch processing": multiClientBatchProcessing,
	"Recurring journal entries": recurringJournalEntries,
	"Exception reporting": exceptionReporting,
};
