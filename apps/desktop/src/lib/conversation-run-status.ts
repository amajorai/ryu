/**
 * The status vocabulary persisted by Core for a conversation run.
 *
 * `interrupted` is intentionally distinct from `failed`: Core writes it at
 * startup for work that was still running when the local engine stopped. That
 * work has a saved partial reply, but no process left to resume it.
 */
export type ConversationRunStatus =
	| "awaiting_input"
	| "completed"
	| "failed"
	| "interrupted"
	| "running";

export interface ConversationRunStatusMeta {
	/** Explains whether the work can make progress without the user. */
	description: string;
	/** Tailwind tone for compact desktop status indicators. */
	dotClass: string;
	/** Whether the row title should show active work. */
	isRunning: boolean;
	/** Brief, visible label. */
	label: string;
	/** Whether the status needs attention even when the chat is marked read. */
	needsAttention: boolean;
}

const STATUS_META = {
	running: {
		label: "In progress",
		description:
			"Working now. It reconnects automatically while the local engine is still running.",
		dotClass: "animate-pulse bg-primary",
		isRunning: true,
		needsAttention: false,
	},
	awaiting_input: {
		label: "Needs input",
		description:
			"Waiting for your response. It will not continue automatically.",
		dotClass: "bg-warning",
		isRunning: false,
		needsAttention: true,
	},
	interrupted: {
		label: "Interrupted",
		description:
			"Stopped when Ryu or its local engine restarted. The partial reply was saved; continue it manually.",
		dotClass: "bg-warning",
		isRunning: false,
		needsAttention: true,
	},
	failed: {
		label: "Failed",
		description:
			"Stopped because the run failed. Open the chat to review it and try again.",
		dotClass: "bg-destructive",
		isRunning: false,
		needsAttention: true,
	},
	completed: {
		label: "Completed",
		description: "Finished successfully.",
		dotClass: "bg-success",
		isRunning: false,
		needsAttention: false,
	},
} satisfies Record<ConversationRunStatus, ConversationRunStatusMeta>;

const STATUS_BY_NAME = new Map(Object.entries(STATUS_META));

/** Unknown future server statuses remain intelligible instead of looking done. */
export function conversationRunStatusMeta(
	status: string | undefined
): ConversationRunStatusMeta | null {
	if (!status) {
		return null;
	}
	return (
		STATUS_BY_NAME.get(status) ?? {
			label: status.replaceAll("_", " "),
			description: `Run status: ${status.replaceAll("_", " ")}.`,
			dotClass: "bg-muted-foreground",
			isRunning: false,
			needsAttention: true,
		}
	);
}
