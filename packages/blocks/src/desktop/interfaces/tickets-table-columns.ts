import type { TicketSortKey } from "./tickets-model.ts";

/** Which columns fit: all of them, fewer, or a two-line mobile row. */
export type TicketsTableLayout = "compact" | "full" | "medium" | "narrow";

export type ColumnId =
	| "assignee"
	| "number"
	| "priority"
	| "requester"
	| "sla"
	| "status"
	| "subject"
	| "updated";

export interface Column {
	id: ColumnId;
	label: string;
	sortKey?: TicketSortKey;
	/** Fixed width in px; the subject takes what is left. */
	width?: number;
}

export const COLUMNS: Record<ColumnId, Column> = {
	assignee: { id: "assignee", label: "Assignee", width: 112 },
	number: { id: "number", label: "ID", sortKey: "number", width: 76 },
	priority: {
		id: "priority",
		label: "Priority",
		sortKey: "priority",
		width: 92,
	},
	requester: {
		id: "requester",
		label: "Requester",
		sortKey: "requester",
		width: 160,
	},
	sla: { id: "sla", label: "Next SLA", sortKey: "sla", width: 96 },
	status: { id: "status", label: "Status", sortKey: "status", width: 96 },
	subject: { id: "subject", label: "Subject", sortKey: "subject" },
	updated: { id: "updated", label: "Updated", sortKey: "updated", width: 136 },
};

export const LAYOUT_COLUMNS: Record<TicketsTableLayout, ColumnId[]> = {
	compact: ["subject", "updated"],
	full: [
		"status",
		"number",
		"subject",
		"requester",
		"priority",
		"sla",
		"updated",
		"assignee",
	],
	medium: [
		"status",
		"number",
		"subject",
		"requester",
		"priority",
		"sla",
		"updated",
	],
	narrow: ["status", "subject", "requester", "sla", "updated"],
};

export const CHECK_WIDTH = 44;
