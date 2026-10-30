import type { InterfaceThread } from "@ryuhq/protocol/interfaces";

export const XP_PER_MESSAGE = 100;
export const XP_PER_LEVEL = 1000;
/** The most agents on the podium (the "Squad size" setting's ceiling and default). */
export const SQUAD_SIZE = 4;
export const MILESTONE_TIERS: readonly number[] = [10, 25, 50, 100, 250];

export function totalMessages(threads: readonly InterfaceThread[]): number {
	let sum = 0;
	for (const thread of threads) {
		sum += Math.max(0, thread.messageCount);
	}
	return sum;
}

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export function threadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled thread";
}
