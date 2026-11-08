// The title an interface shows for a conversation. An untitled conversation
// carries Core's English placeholder (`UNTITLED`, "New Chat") or nothing at
// all; both read as the localized "New chat" so no interface shows the
// English placeholder under another UI language.

import { UNTITLED } from "@/src/contexts/chat-history/core-conversation.ts";
import { activeTranslate, type SnapshotTranslate } from "./snapshot-util.ts";

/**
 * A conversation's display title: the user's own title verbatim, or the
 * localized "New chat" for an empty title or the persisted placeholder.
 */
export function displayThreadTitle(
	title: string | null | undefined,
	tl: SnapshotTranslate = activeTranslate
): string {
	const trimmed = title?.trim() ?? "";
	if (trimmed === "" || trimmed === UNTITLED) {
		return tl("New chat");
	}
	return trimmed;
}
