import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import { RECORDS_STATUS_ORDER, type RecordsRow } from "./records-model.ts";

// ---------------------------------------------------------------------------
// Board (by status)
// ---------------------------------------------------------------------------

export interface RecordsBoardColumn {
	rows: RecordsRow[];
	status: ThreadStatus;
}

/** One column per stage, in stage order, keeping the table's sort inside. */
export function recordsBoard(
	rows: readonly RecordsRow[]
): RecordsBoardColumn[] {
	return RECORDS_STATUS_ORDER.map((status) => ({
		rows: rows.filter((row) => row.status === status),
		status,
	}));
}
