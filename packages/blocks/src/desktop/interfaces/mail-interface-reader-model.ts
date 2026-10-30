import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	mailLongDate,
	mailStatusChip,
	mailSubject,
	mailThreadLabels,
} from "./mail-model.ts";
import type { MailReaderModel } from "./mail-reader.tsx";

/** The reading pane's model for one thread of the current view's list. */
export function mailReaderModelFor(
	snapshot: InterfaceSnapshot,
	threads: readonly InterfaceThread[],
	thread: InterfaceThread,
	now: number
): MailReaderModel {
	const index = threads.findIndex((candidate) => candidate.id === thread.id);
	const participants = thread.agentIds
		.map((agentId) => snapshot.agents.find((agent) => agent.id === agentId))
		.filter((agent) => agent !== undefined);
	return {
		cc: participants.slice(1),
		date: mailLongDate(thread.updatedAt, now),
		labels: mailThreadLabels(snapshot, thread),
		position: index === -1 ? null : { index, total: threads.length },
		sender: participants[0] ?? null,
		status: mailStatusChip(thread),
		subject: mailSubject(thread),
		thread,
	};
}
