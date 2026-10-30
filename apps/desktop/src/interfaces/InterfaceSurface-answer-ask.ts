import type { InterfaceAsk } from "@ryuhq/protocol/interfaces";

/**
 * Answer an ask in place for the shared ask card. Approvals go through the
 * pending-approvals hook; anything this host cannot answer in place opens its
 * thread (or the inbox) so the user answers there. Never sends a message.
 */
export interface AnswerAskDeps {
	approve: (id: string) => Promise<unknown>;
	/** The ask as the latest snapshot holds it, or null once it is gone. */
	currentAsk: (askId: string) => InterfaceAsk | null;
	/** The respond callback a mounted chat tab on the active node published
	 *  for this ask's own thread; null when none holds it. */
	livePermission: (ask: InterfaceAsk) => ((optionId: string) => unknown) | null;
	openInbox: () => void;
	openThread: (threadId: string) => void;
	/** Where a Question card's answer posts: the conversation on the active
	 *  node holding this ask for its own thread; null when none (or more than
	 *  one) does. */
	questionHolder: (
		ask: InterfaceAsk
	) => { conversationId: string; toolCallId: string } | null;
	/** The latest snapshot is redacted: nothing is answered in place. */
	redacted: () => boolean;
	reject: (id: string) => Promise<unknown>;
	respondQuestion: (
		conversationId: string,
		toolCallId: string,
		answers: unknown[]
	) => Promise<{ resolved: boolean }>;
}

export async function answerAskWith(
	deps: AnswerAskDeps,
	askId: string,
	choiceId: string
): Promise<void> {
	const ask = deps.currentAsk(askId);
	if (!ask) {
		// Answered elsewhere or expired: the card shows "No longer waiting".
		return;
	}
	const openWhereItLives = () => {
		if (ask.threadId) {
			deps.openThread(ask.threadId);
		} else {
			deps.openInbox();
		}
	};
	if (deps.redacted()) {
		openWhereItLives();
		return;
	}
	if (askId.startsWith("approval:")) {
		const id = askId.slice("approval:".length);
		if (choiceId === "approve") {
			await deps.approve(id);
			return;
		}
		if (choiceId === "reject") {
			await deps.reject(id);
			return;
		}
	}
	if (askId.startsWith("question:")) {
		// The holder of the ask on screen (its thread, this node), never a
		// search: tool-call ids repeat across threads.
		const holder = deps.questionHolder(ask);
		if (!holder) {
			openWhereItLives();
			return;
		}
		let resolved = false;
		try {
			const result = await deps.respondQuestion(
				holder.conversationId,
				holder.toolCallId,
				[{ kind: "single", selectedIds: [choiceId] }]
			);
			resolved = result.resolved;
		} catch {
			resolved = false;
		}
		if (!resolved) {
			// No turn is waiting: answer in the thread's own card, never by a
			// synthetic message. The ask stays until the thread says otherwise.
			openWhereItLives();
		}
		return;
	}
	if (askId.startsWith("permission:")) {
		// The tab holding the ask on screen (its thread, this node), never a
		// search: `perm-<seq>` ids repeat across nodes and Core restarts.
		const respond = deps.livePermission(ask);
		if (respond) {
			await respond(choiceId);
			return;
		}
	}
	openWhereItLives();
}

/**
 * The one ask in a snapshot with this id. Two asks sharing an id (a tool-call
 * id repeated by two threads) cannot tell which card was tapped, so the
 * answer is refused and the card shows that it did not go through.
 */
export function snapshotAsk(
	asks: readonly InterfaceAsk[] | undefined,
	askId: string
): InterfaceAsk | null {
	const matches = (asks ?? []).filter((ask) => ask.id === askId);
	if (matches.length > 1) {
		throw new Error("More than one ask has this id");
	}
	return matches[0] ?? null;
}
