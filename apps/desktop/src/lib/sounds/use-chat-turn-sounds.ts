import { useEffect, useRef } from "react";
import { markRunStarted, playSound } from "./play-sound.ts";

/** The AI SDK `useChat` status values this hook reacts to. */
export type ChatTurnStatus = "submitted" | "streaming" | "ready" | "error";

const IN_FLIGHT: ReadonlySet<ChatTurnStatus> = new Set([
	"submitted",
	"streaming",
]);

/**
 * Turn a chat's status transitions into cues: a tick when the user sends, the
 * Ryu motif when the run finishes, a falling fifth when it fails. Only a turn
 * that was actually in flight sounds, so mounting a ready tab or restoring a
 * tab is silent. A Stop is handled by `markRunStopped`; a new turn calls
 * `markRunStarted`, so a Stop (or the previous turn's cue) never swallows the
 * next turn's completion, for example after a queued message is force-sent.
 */
export function useChatTurnSounds(
	status: ChatTurnStatus,
	conversationId: string | null | undefined
): void {
	const previous = useRef<{
		conversationId: string | null;
		status: ChatTurnStatus;
	}>({ conversationId: conversationId ?? null, status });

	useEffect(() => {
		const prior = previous.current;
		const currentId = conversationId ?? null;
		previous.current = { conversationId: currentId, status };
		// Switching to another thread is not a transition of this turn. A draft
		// gaining its first id mid-turn (null -> id) still is.
		if (
			prior.conversationId !== null &&
			currentId !== null &&
			prior.conversationId !== currentId
		) {
			return;
		}
		if (prior.status === status) {
			return;
		}
		const key = currentId ? `run:${currentId}` : undefined;
		if (status === "submitted") {
			markRunStarted(currentId);
			playSound("message-sent", { gesture: true });
			return;
		}
		if (!IN_FLIGHT.has(prior.status)) {
			return;
		}
		if (status === "ready") {
			playSound("run-complete", { key });
		} else if (status === "error") {
			playSound("run-failed", { key });
		}
	}, [status, conversationId]);
}
