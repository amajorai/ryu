// Asks read from hydrated message detail and live tabs (questions and
// permission prompts), and when "question" leaves the blind spots.

import type { InterfaceAsk, InterfaceThread } from "@ryuhq/protocol/interfaces";
import { interfaceDetailRevision } from "@/src/lib/interface-detail.ts";
import type { Conversation } from "@/types/chat.ts";
import { detailOf } from "./snapshot-live.ts";
import type { InterfaceDetailInput } from "./use-interface-detail.ts";

/** Open Question asks from every hydrated conversation (mains and helper
 *  sessions), lifted to snapshot threads; blocking ones only while the
 *  holding conversation runs and before their upper-bound deadline. */
export function questionAsks(
	conversations: readonly Conversation[],
	statusOf: (conversation: Conversation) => string | undefined,
	detail: InterfaceDetailInput,
	threadIds: ReadonlySet<string>,
	nowMs: number
): InterfaceAsk[] {
	const asks: InterfaceAsk[] = [];
	for (const conversation of conversations) {
		const entry = detailOf(detail, conversation.id);
		if (!entry) {
			continue;
		}
		const running = statusOf(conversation) === "running";
		for (const { ask } of entry.questionAsks) {
			if (!(ask.threadId && threadIds.has(ask.threadId))) {
				continue;
			}
			if (ask.blocking) {
				const expires = ask.expiresAt ? Date.parse(ask.expiresAt) : Number.NaN;
				if (!running || (Number.isFinite(expires) && nowMs > expires)) {
					continue;
				}
			}
			asks.push(ask);
		}
	}
	return asks;
}

/** Live-tab permission asks, while their thread runs and before expiry. */
export function permissionAsks(
	threads: readonly InterfaceThread[],
	ownRunning: ReadonlySet<string>,
	detail: InterfaceDetailInput,
	nowMs: number
): InterfaceAsk[] {
	const asks: InterfaceAsk[] = [];
	for (const thread of threads) {
		const ask = detail.live.get(thread.id)?.permission?.ask;
		// The thread's own run, not one lifted from a helper, holds the prompt.
		if (!(ask && ownRunning.has(thread.id))) {
			continue;
		}
		const expires = ask.expiresAt ? Date.parse(ask.expiresAt) : Number.NaN;
		if (Number.isFinite(expires) && nowMs > expires) {
			continue;
		}
		asks.push(ask);
	}
	return asks;
}

/** "question" leaves the blind spots only when every running main and helper
 *  session is hydrated at its current revision within the cap, and the idle
 *  sweep has read every thread updated in the last 7 days. */
export function questionCovered(
	conversations: readonly Conversation[],
	statusOf: (conversation: Conversation) => string | undefined,
	detail: InterfaceDetailInput
): boolean {
	if (!(detail.runningWithinCap && detail.sweepComplete)) {
		return false;
	}
	const runningParents = new Set<string>();
	for (const conversation of conversations) {
		const parent = conversation.hierarchy?.spawnedByConversationId;
		if (parent && statusOf(conversation) === "running") {
			runningParents.add(parent);
		}
	}
	return conversations
		.filter(
			(conversation) =>
				!conversation.archived &&
				(statusOf(conversation) === "running" ||
					runningParents.has(conversation.id))
		)
		.every((conversation) => {
			const entry = detail.entries.get(conversation.id);
			return (
				entry?.status === "ready" &&
				entry.revision ===
					interfaceDetailRevision({
						messageCount:
							conversation.messageCount ?? conversation.messages.length,
						runStatus: statusOf(conversation),
						updatedAt: conversation.updatedAt,
					})
			);
		});
}
