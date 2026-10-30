import {
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export function statusRank(thread: InterfaceThread): number {
	return THREAD_STATUS_ORDER.indexOf(threadStatus(thread));
}
