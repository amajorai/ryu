import type { ChatCheckpoint } from "@/src/lib/api/chat-checkpoints.ts";

/** Which checkpoint to select when the rewind picker opens: a user message's
 *  id, or its text when the message has only a client-side id so far (a turn
 *  sent in this session keeps its client id until the chat reloads). */
export interface RewindPreselect {
	messageId?: string;
	text?: string;
}

/** Pick the checkpoint for `preselect`, falling back to the newest one. */
export function pickInitialCheckpoint(
	checkpoints: ChatCheckpoint[],
	preselect: RewindPreselect | null
): string | null {
	const turns = checkpoints.filter((checkpoint) => checkpoint.kind === "turn");
	if (preselect?.messageId) {
		const byId = turns.find(
			(checkpoint) => checkpoint.messageId === preselect.messageId
		);
		if (byId) {
			return byId.id;
		}
	}
	const text = preselect?.text?.trim();
	if (text) {
		const byText = turns.find((checkpoint) => {
			const preview = checkpoint.preview?.replace(/…$/, "").trim();
			return Boolean(preview) && text.startsWith(preview ?? "");
		});
		if (byText) {
			return byText.id;
		}
	}
	return checkpoints[0]?.id ?? null;
}
