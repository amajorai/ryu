// apps/desktop/src/components/chat/import-operation-summary.ts
//
// How the imports a surface started stand, taken together: one status, one
// progress count, the counts of the outcomes and the sentence for an import
// that ended early. Pure functions over the node's operation records, shared
// by `ImportOperationStatus` and the onboarding migration step.

import type { LiteralMessage } from "@ryu/i18n";
import type { ImportOutcome } from "@/src/lib/api/import.ts";
import type { Operation, OperationStatus } from "@/src/lib/api/operations.ts";

/** How the imports of one surface stand, taken together. */
export interface ImportOperationsSummary {
	/** A stop was asked for and something is still running. */
	cancelRequested: boolean;
	done: number;
	/** The node's error text of the first failed import, if any. */
	error?: string;
	/** Something continued after a node restart. */
	resumed: boolean;
	/** `running` while anything is queued or running; then the worst end. */
	status: OperationStatus;
	total: number;
}

const END_ORDER: OperationStatus[] = [
	"interrupted",
	"failed",
	"cancelled",
	"succeeded",
];

export function summarizeImportOperations(
	operations: readonly Operation[]
): ImportOperationsSummary | null {
	if (operations.length === 0) {
		return null;
	}
	const statuses = new Set(operations.map((o) => o.status));
	let status: OperationStatus = "succeeded";
	if (statuses.has("running")) {
		status = "running";
	} else if (statuses.has("queued")) {
		// All queued: an import of another surface runs first. Queued next to
		// finished ones: the node is between two of our imports.
		status = statuses.size === 1 ? "queued" : "running";
	} else {
		status = END_ORDER.find((end) => statuses.has(end)) ?? "succeeded";
	}
	const active = status === "running" || status === "queued";
	return {
		cancelRequested: active && operations.some((o) => o.cancelRequested),
		done: operations.reduce((sum, o) => sum + o.progress.done, 0),
		error: operations.find((o) => o.status === "failed" && o.error)?.error,
		resumed: operations.some(
			(o) => o.resumed && (o.status === "running" || o.status === "queued")
		),
		status,
		total: operations.reduce((sum, o) => sum + o.progress.total, 0),
	};
}

/** Counts of the outcomes read so far. */
export function importTotals(outcomes: readonly ImportOutcome[]) {
	const imported = outcomes.filter((o) => o.status === "imported").length;
	const failed = outcomes.filter((o) => o.status === "failed").length;
	return { failed, imported, skipped: outcomes.length - imported - failed };
}

/** The sentence for an import that ended without finishing. */
export function importEndMessage(
	status: OperationStatus,
	tl: LiteralMessage
): string | null {
	if (status === "interrupted") {
		return tl(
			"The node restarted during this import. Items already imported are kept."
		);
	}
	if (status === "failed") {
		return tl(
			"The import stopped with an error. Items already imported are kept."
		);
	}
	if (status === "cancelled") {
		return tl("The import was stopped. Items already imported are kept.");
	}
	return null;
}
